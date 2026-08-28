import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import type { FileStatus } from "../domain/file";
import { DomainError } from "../domain/errors";
import { getConfig, type AppConfig } from "../env";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { adminLoginRateLimitMiddleware } from "../middleware/admin-login-rate-limit";
import { jsonBodyLimitMiddleware } from "../middleware/request-protection";
import { listAdminFiles } from "../repositories/file-repository";
import {
  createInvitation,
  issueAdditionalInvitationToken,
  invitationStatus,
  listInvitations,
  reissueInvitationToken,
  revokeInvitation,
} from "../repositories/invitation-repository";
import { getStorageUsage } from "../repositories/quota-repository";
import { reconcileStorage, runCleanup } from "../services/cleanup-service";
import { deleteFileAsAdmin } from "../services/deletion-service";
import {
  issueAdminSession,
  revokeAllAdminSessions,
  revokeCurrentAdminSession,
} from "../services/admin-session-service";
import { toPublicFile } from "../services/file-service";
import { createInvitationTokenHash } from "../services/invitation-service";
import { verifyTurnstile } from "../services/turnstile-service";
import { randomToken } from "../utils/hash";
import { timingSafeStringEqual } from "../utils/hash";
import { readJsonBody } from "../utils/request";

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
  readonly canUpload: boolean;
  readonly maxFiles: number;
  readonly unlimitedFiles: boolean;
  readonly maxBytes: number;
}

function parseCreateInvitation(value: unknown, config: AppConfig): CreateInvitationRequest {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("INVALID_REQUEST", 400, "邀請資料格式不正確。");
  }
  const record = value as Record<string, unknown>;
  const label = record.label;
  const expiresInSeconds = record.expiresInSeconds ?? config.invitationDefaultTtlSeconds;
  const canUpload = record.canUpload ?? true;
  const maxFiles = record.maxFiles ?? config.invitationDefaultMaxFiles;
  const unlimitedFiles = record.unlimitedFiles ?? false;
  const maxBytes = record.maxBytes ?? config.invitationDefaultMaxBytes;
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.trim().length > 80 ||
    !Number.isSafeInteger(expiresInSeconds) ||
    (expiresInSeconds as number) < config.invitationMinTtlSeconds ||
    (expiresInSeconds as number) > config.invitationMaxTtlSeconds ||
    typeof canUpload !== "boolean" ||
    (canUpload &&
      (!Number.isSafeInteger(maxFiles) ||
        (maxFiles as number) < 1 ||
        (maxFiles as number) > config.invitationMaxFiles ||
        typeof unlimitedFiles !== "boolean" ||
        !Number.isSafeInteger(maxBytes) ||
        (maxBytes as number) < 1 ||
        (maxBytes as number) > config.maxStorageBytes))
  ) {
    throw new DomainError("INVALID_REQUEST", 400, "邀請限制格式不正確。");
  }
  return {
    label: label.trim(),
    expiresInSeconds: expiresInSeconds as number,
    canUpload,
    maxFiles: canUpload ? (maxFiles as number) : 1,
    unlimitedFiles: canUpload ? (unlimitedFiles as boolean) : false,
    maxBytes: canUpload ? (maxBytes as number) : 1,
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

adminRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  await next();
});

function logAdminLogin(requestId: string, success: boolean): void {
  console[success ? "log" : "warn"](
    JSON.stringify({
      level: success ? "info" : "warn",
      event: success ? "admin_login.succeeded" : "admin_login.failed",
      timestamp: new Date().toISOString(),
      requestId,
    }),
  );
}

function adminLoginFailure(): DomainError {
  return new DomainError("INVALID_REQUEST", 401, "管理員驗證失敗。");
}

adminRoutes.post(
  "/session",
  adminLoginRateLimitMiddleware,
  jsonBodyLimitMiddleware,
  async (context) => {
    const authorization = context.req.header("Authorization");
    const match = /^Bearer\s+(.+)$/u.exec(authorization ?? "");
    let input: unknown;
    try {
      input = await context.req.json<unknown>();
    } catch {
      logAdminLogin(context.get("requestId"), false);
      throw adminLoginFailure();
    }
    const turnstileToken =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>).turnstileToken
        : null;
    if (typeof turnstileToken !== "string") {
      logAdminLogin(context.get("requestId"), false);
      throw adminLoginFailure();
    }
    try {
      await verifyTurnstile(
        context.env,
        turnstileToken,
        context.req.header("CF-Connecting-IP") ?? "local-development",
        context.get("requestId"),
        "admin",
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "TURNSTILE_FAILED") {
        logAdminLogin(context.get("requestId"), false);
        throw adminLoginFailure();
      }
      throw error;
    }
    if (
      match?.[1] === undefined ||
      !(await timingSafeStringEqual(match[1], context.env.ADMIN_TOKEN))
    ) {
      logAdminLogin(context.get("requestId"), false);
      throw adminLoginFailure();
    }
    const expiresAt = await issueAdminSession(context);
    logAdminLogin(context.get("requestId"), true);
    return context.json({
      authenticated: true,
      sessionExpiresAt: new Date(expiresAt * 1000).toISOString(),
    });
  },
);

adminRoutes.use("*", adminAuthMiddleware);

adminRoutes.get("/session", (context) => {
  return context.json({ authenticated: true });
});

adminRoutes.delete("/session", async (context) => {
  await revokeCurrentAdminSession(context);
  return context.body(null, 204);
});

adminRoutes.post("/sessions/revoke-all", async (context) => {
  await revokeAllAdminSessions(context);
  return context.body(null, 204);
});

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
  const now = Math.floor(Date.now() / 1000);
  const cursor = decodeCursor(context.req.query("cursor"));
  const files = await listAdminFiles(context.env.DB, {
    status,
    mime: context.req.query("mime") ?? null,
    createdBefore: parseOptionalEpoch(context.req.query("createdBefore")),
    createdAfter: parseOptionalEpoch(context.req.query("createdAfter")),
    expiresBefore: parseOptionalEpoch(context.req.query("expiresBefore")),
    expiresAfter: status === "active" ? now : null,
    cursorCreatedAt: cursor.createdAt,
    cursorId: cursor.id,
    limit: limit + 1,
  });
  const hasMore = files.length > limit;
  const page = hasMore ? files.slice(0, limit) : files;
  const last = page.at(-1);

  return context.json({
    files: page.map((file) => {
      const publicFile =
        file.status === "active" && file.expires_at > now
          ? toPublicFile(file, getConfig(context.env))
          : null;
      return {
        id: file.id,
        filename: file.original_name,
        extension: file.extension,
        declaredMime: file.declared_mime,
        detectedMime: file.detected_mime,
        sizeBytes: file.size_bytes,
        previewPolicy: file.preview_policy,
        previewUrl: publicFile?.previewUrl ?? null,
        downloadUrl: publicFile?.downloadUrl ?? null,
        status: file.status,
        createdAt: new Date(file.created_at * 1000).toISOString(),
        expiresAt: new Date(file.expires_at * 1000).toISOString(),
        deletedAt: file.deleted_at === null ? null : new Date(file.deleted_at * 1000).toISOString(),
      };
    }),
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  });
});

adminRoutes.post("/invitations", jsonBodyLimitMiddleware, async (context) => {
  const config = getConfig(context.env);
  const input = parseCreateInvitation(await readJsonBody(context), config);
  const now = Math.floor(Date.now() / 1000);
  const token = randomToken(32);
  const id = randomToken(16);
  await createInvitation(context.env.DB, {
    id,
    tokenHash: await createInvitationTokenHash(context.env.DELETE_TOKEN_PEPPER, token),
    label: input.label,
    maxFiles: input.maxFiles,
    unlimitedFiles: input.unlimitedFiles,
    maxBytes: input.maxBytes,
    canUpload: input.canUpload,
    createdAt: now,
    expiresAt: now + input.expiresInSeconds,
  });

  return context.json(
    {
      id,
      label: input.label,
      inviteUrl: `${config.uploadOrigin}/invite#token=${token}`,
      token,
      canUpload: input.canUpload,
      maxFiles: input.canUpload ? input.maxFiles : 0,
      unlimitedFiles: input.canUpload ? input.unlimitedFiles : false,
      maxBytes: input.canUpload ? input.maxBytes : 0,
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
      canUpload: invitation.can_upload === 1,
      maxFiles: invitation.can_upload === 1 ? invitation.max_files : 0,
      unlimitedFiles: invitation.can_upload === 1 && invitation.unlimited_files === 1,
      maxBytes: invitation.can_upload === 1 ? invitation.max_bytes : 0,
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

adminRoutes.post("/invitations/:invitationId/copy", async (context) => {
  const config = getConfig(context.env);
  const now = Math.floor(Date.now() / 1000);
  const token = randomToken(32);
  const invitation = await issueAdditionalInvitationToken(
    context.env.DB,
    context.req.param("invitationId"),
    await createInvitationTokenHash(context.env.DELETE_TOKEN_PEPPER, token),
    now,
  );
  if (invitation === null) {
    throw new DomainError("INVITATION_INVALID", 409, "只有尚未到期的有效邀請可以複製。");
  }

  return context.json({
    id: invitation.id,
    label: invitation.label,
    inviteUrl: `${config.uploadOrigin}/invite#token=${token}`,
    token,
    canUpload: invitation.can_upload === 1,
    maxFiles: invitation.can_upload === 1 ? invitation.max_files : 0,
    unlimitedFiles: invitation.can_upload === 1 && invitation.unlimited_files === 1,
    maxBytes: invitation.can_upload === 1 ? invitation.max_bytes : 0,
    expiresAt: new Date(invitation.expires_at * 1000).toISOString(),
  });
});

adminRoutes.post("/invitations/:invitationId/reissue", async (context) => {
  const config = getConfig(context.env);
  const now = Math.floor(Date.now() / 1000);
  const token = randomToken(32);
  const invitation = await reissueInvitationToken(
    context.env.DB,
    context.req.param("invitationId"),
    await createInvitationTokenHash(context.env.DELETE_TOKEN_PEPPER, token),
    now,
  );
  if (invitation === null) {
    throw new DomainError("INVITATION_INVALID", 409, "只有尚未到期的有效邀請可以重新簽發。");
  }

  return context.json({
    id: invitation.id,
    label: invitation.label,
    inviteUrl: `${config.uploadOrigin}/invite#token=${token}`,
    token,
    canUpload: invitation.can_upload === 1,
    maxFiles: invitation.can_upload === 1 ? invitation.max_files : 0,
    unlimitedFiles: invitation.can_upload === 1 && invitation.unlimited_files === 1,
    maxBytes: invitation.can_upload === 1 ? invitation.max_bytes : 0,
    expiresAt: new Date(invitation.expires_at * 1000).toISOString(),
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
