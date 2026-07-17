import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import type { FileStatus } from "../domain/file";
import { DomainError } from "../domain/errors";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { listAdminFiles } from "../repositories/file-repository";
import { getStorageUsage } from "../repositories/quota-repository";
import { reconcileStorage, runCleanup } from "../services/cleanup-service";
import { deleteFileAsAdmin } from "../services/deletion-service";

const FILE_STATUSES = new Set<FileStatus>([
  "reserved",
  "uploading",
  "active",
  "deleting",
  "deleted",
  "rejected",
  "failed",
]);

function parseOptionalEpoch(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DomainError("INVALID_REQUEST", 400, "時間篩選格式不正確。");
  }
  return parsed;
}

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string | undefined): {
  createdAt: number | null;
  id: string | null;
} {
  if (cursor === undefined) {
    return { createdAt: null, id: null };
  }

  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (separator <= 0 || !Number.isSafeInteger(createdAt) || id.length === 0) {
      throw new Error("Invalid cursor");
    }
    return { createdAt, id };
  } catch {
    throw new DomainError("INVALID_REQUEST", 400, "游標格式不正確。");
  }
}

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", adminAuthMiddleware);

adminRoutes.get("/status", async (context) => {
  const [usage, statusCounts] = await Promise.all([
    getStorageUsage(context.env.DB),
    context.env.DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM files
       GROUP BY status`,
    ).all<{ status: FileStatus; count: number }>(),
  ]);

  return context.json({
    storage: {
      usedBytes: usage.used_bytes,
      reservedBytes: usage.reserved_bytes,
      maxBytes: usage.max_bytes,
      updatedAt: new Date(usage.updated_at * 1000).toISOString(),
    },
    filesByStatus: Object.fromEntries(statusCounts.results.map((row) => [row.status, row.count])),
  });
});

adminRoutes.get("/files", async (context) => {
  const statusValue = context.req.query("status");
  const status =
    statusValue === undefined
      ? null
      : FILE_STATUSES.has(statusValue as FileStatus)
        ? (statusValue as FileStatus)
        : null;
  if (statusValue !== undefined && status === null) {
    throw new DomainError("INVALID_REQUEST", 400, "檔案狀態篩選不正確。");
  }

  const requestedLimit = Number(context.req.query("limit") ?? "50");
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new DomainError("INVALID_REQUEST", 400, "limit 格式不正確。");
  }
  const limit = Math.min(100, requestedLimit);
  const cursor = decodeCursor(context.req.query("cursor"));
  const files = await listAdminFiles(context.env.DB, {
    status,
    mime: context.req.query("mime") ?? null,
    createdBefore: parseOptionalEpoch(context.req.query("createdBefore")),
    createdAfter: parseOptionalEpoch(context.req.query("createdAfter")),
    expiresBefore: parseOptionalEpoch(context.req.query("expiresBefore")),
    cursorCreatedAt: cursor.createdAt,
    cursorId: cursor.id,
    limit: limit + 1,
  });
  const hasMore = files.length > limit;
  const page = hasMore ? files.slice(0, limit) : files;
  const last = page.at(-1);

  return context.json({
    files: page.map((file) => ({
      id: file.id,
      filename: file.original_name,
      extension: file.extension,
      declaredMime: file.declared_mime,
      detectedMime: file.detected_mime,
      sizeBytes: file.size_bytes,
      previewPolicy: file.preview_policy,
      status: file.status,
      createdAt: new Date(file.created_at * 1000).toISOString(),
      expiresAt: new Date(file.expires_at * 1000).toISOString(),
      deletedAt: file.deleted_at === null ? null : new Date(file.deleted_at * 1000).toISOString(),
    })),
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  });
});

adminRoutes.post("/cleanup", async (context) => {
  return context.json(await runCleanup(context.env));
});

adminRoutes.post("/reconcile", async (context) => {
  return context.json(await reconcileStorage(context.env));
});

adminRoutes.delete("/files/:fileId", async (context) => {
  await deleteFileAsAdmin(context.env, context.req.param("fileId"), Math.floor(Date.now() / 1000));
  return context.body(null, 204);
});
