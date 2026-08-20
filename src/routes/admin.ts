import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import type { FileStatus } from "../domain/file";
import { DomainError } from "../domain/errors";
import { getConfig, type AppConfig } from "../env";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { listAdminFiles } from "../repositories/file-repository";
import {
  createInvitation,
  invitationStatus,
  listInvitations,
  revokeInvitation,
} from "../repositories/invitation-repository";
import { getStorageUsage } from "../repositories/quota-repository";
import { reconcileStorage, runCleanup } from "../services/cleanup-service";
import { deleteFileAsAdmin } from "../services/deletion-service";
import { createInvitationTokenHash } from "../services/invitation-service";
import { randomToken } from "../utils/hash";

const FILE_STATUSES = new Set<FileStatus>([
  "reserved",
  "uploading",
  "active",
  "deleting",
  "deleted",
  "rejected",
  "failed",
]);

interface CreateInvitationRequest {
  readonly label: string;
  readonly expiresInSeconds: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

function parseCreateInvitation(value: unknown, config: AppConfig): CreateInvitationRequest {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("INVALID_REQUEST", 400, "邀請資料格式不正確。");
  }
  const record = value as Record<string, unknown>;
  const label = record.label;
  const expiresInSeconds = record.expiresInSeconds ?? config.invitationDefaultTtlSeconds;
  const maxFiles = record.maxFiles ?? config.invitationDefaultMaxFiles;
  const maxBytes = record.maxBytes ?? config.invitationDefaultMaxBytes;
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.trim().length > 80 ||
    !Number.isSafeInteger(expiresInSeconds) ||
    (expiresInSeconds as number) < config.invitationMinTtlSeconds ||
    (expiresInSeconds as number) > config.invitationMaxTtlSeconds ||
    !Number.isSafeInteger(maxFiles) ||
    (maxFiles as number) < 1 ||
    (maxFiles as number) > config.invitationMaxFiles ||
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < 1 ||
    (maxBytes as number) > config.maxStorageBytes
  ) {
    throw new DomainError("INVALID_REQUEST", 400, "邀請限制格式不正確。");
  }
  return {
    label: label.trim(),
    expiresInSeconds: expiresInSeconds as number,
    maxFiles: maxFiles as number,
    maxBytes: maxBytes as number,
  };
}

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

adminRoutes.post("/invitations", async (context) => {
  const config = getConfig(context.env);
  const input = parseCreateInvitation(await context.req.json<unknown>(), config);
  const now = Math.floor(Date.now() / 1000);
  const token = randomToken(32);
  const id = randomToken(16);
  await createInvitation(context.env.DB, {
    id,
    tokenHash: await createInvitationTokenHash(context.env.DELETE_TOKEN_PEPPER, token),
    label: input.label,
    maxFiles: input.maxFiles,
    maxBytes: input.maxBytes,
    createdAt: now,
    expiresAt: now + input.expiresInSeconds,
  });

  return context.json(
    {
      id,
      label: input.label,
      inviteUrl: `${config.uploadOrigin}/invite#token=${token}`,
      token,
      maxFiles: input.maxFiles,
      maxBytes: input.maxBytes,
      expiresAt: new Date((now + input.expiresInSeconds) * 1000).toISOString(),
    },
    201,
  );
});

adminRoutes.get("/invitations", async (context) => {
  const now = Math.floor(Date.now() / 1000);
  const invitations = await listInvitations(context.env.DB);
  return context.json({
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      label: invitation.label,
      status: invitationStatus(invitation, now),
      maxFiles: invitation.max_files,
      maxBytes: invitation.max_bytes,
      usedFiles: invitation.used_files,
      usedBytes: invitation.used_bytes,
      createdAt: new Date(invitation.created_at * 1000).toISOString(),
      expiresAt: new Date(invitation.expires_at * 1000).toISOString(),
      revokedAt:
        invitation.revoked_at === null
          ? null
          : new Date(invitation.revoked_at * 1000).toISOString(),
    })),
  });
});

adminRoutes.delete("/invitations/:invitationId", async (context) => {
  await revokeInvitation(
    context.env.DB,
    context.req.param("invitationId"),
    Math.floor(Date.now() / 1000),
  );
  return context.body(null, 204);
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
