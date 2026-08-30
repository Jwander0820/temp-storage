import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { TEMP_OBJECT_PREFIX } from "../domain/storage";
import type { ReserveUploadInput } from "../domain/upload";
import { getConfig } from "../env";
import {
  jsonBodyLimitMiddleware,
  uploadMutationRateLimitMiddleware,
} from "../middleware/request-protection";
import { uploadSessionMiddleware } from "../middleware/upload-session";
import { reserveQuotaAndCreateRecords } from "../repositories/quota-repository";
import {
  claimUpload,
  completeUpload,
  getUploadRecord,
  releaseReservation,
} from "../repositories/upload-repository";
import { classifyFile, isBlockedDeclaredMime } from "../services/file-type-service";
import { toPublicFile } from "../services/file-service";
import { storeObject } from "../services/r2-service";
import { getExtension, isBlockedExtension, sanitizeOriginalFilename } from "../utils/filename";
import { createDeleteToken, createFileId, hashPepperedValue } from "../utils/hash";
import { readJsonBody } from "../utils/request";
import { peekStream } from "../utils/stream";

function parseReserveInput(value: unknown): ReserveUploadInput {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("INVALID_REQUEST", 400, "上傳資料格式不正確。");
  }

  const record = value as Record<string, unknown>;
  const filename = record.filename;
  const sizeBytes = record.sizeBytes;
  const declaredMime = record.declaredMime;

  if (
    typeof filename !== "string" ||
    typeof sizeBytes !== "number" ||
    (declaredMime !== undefined && declaredMime !== null && typeof declaredMime !== "string")
  ) {
    throw new DomainError("INVALID_REQUEST", 400, "上傳資料格式不正確。");
  }

  return {
    filename,
    sizeBytes,
    declaredMime: declaredMime ?? null,
  };
}

function dateBucket(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function objectKey(fileId: string, epochSeconds: number): string {
  const [year, month, day] = dateBucket(epochSeconds).split("-");
  return `${TEMP_OBJECT_PREFIX}${year}/${month}/${day}/${fileId}`;
}

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use("/uploads/*", uploadMutationRateLimitMiddleware);
uploadRoutes.use("/uploads/*", uploadSessionMiddleware);
uploadRoutes.use("/uploads/*", async (context, next) => {
  if (!context.get("uploadCanUpload")) {
    throw new DomainError(
      "UPLOAD_NOT_ALLOWED",
      403,
      "這是僅瀏覽邀請，可瀏覽與下載檔案，但不能上傳。",
    );
  }
  await next();
});

uploadRoutes.post("/uploads/reserve", jsonBodyLimitMiddleware, async (context) => {
  const config = getConfig(context.env);
  if (!config.uploadsEnabled) {
    throw new DomainError("UPLOADS_DISABLED", 503, "目前暫停接受新上傳。");
  }

  const input = parseReserveInput(await readJsonBody(context));
  const filename = sanitizeOriginalFilename(input.filename);
  if (filename.length === 0 || input.filename.length > 255) {
    throw new DomainError("INVALID_REQUEST", 400, "檔名長度不正確。");
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new DomainError("INVALID_REQUEST", 400, "檔案大小不正確。");
  }
  if (input.sizeBytes > config.maxFileBytes) {
    throw new DomainError("FILE_TOO_LARGE", 413, "單一檔案超過目前設定的大小上限。");
  }

  const extension = getExtension(filename);
  if (isBlockedExtension(extension) || isBlockedDeclaredMime(input.declaredMime)) {
    throw new DomainError("FILE_TYPE_BLOCKED", 400, "這個檔案類型不允許上傳。");
  }

  const remoteIp = context.req.header("CF-Connecting-IP") ?? "local-development";

  const now = Math.floor(Date.now() / 1000);
  const previousDay = now - 86400;
  const [uploaderHash, previousUploaderHash] = await Promise.all([
    hashPepperedValue(context.env.IP_HASH_PEPPER, `${dateBucket(now)}\u0000${remoteIp}`),
    hashPepperedValue(context.env.IP_HASH_PEPPER, `${dateBucket(previousDay)}\u0000${remoteIp}`),
  ]);

  const fileId = createFileId();
  const reservationId = fileId;
  await reserveQuotaAndCreateRecords(
    context.env.DB,
    {
      eventId: crypto.randomUUID(),
      reservationId,
      fileId,
      objectKey: objectKey(fileId, now),
      filename,
      extension,
      declaredMime: input.declaredMime?.slice(0, 255) ?? null,
      sizeBytes: input.sizeBytes,
      uploaderHash,
      previousUploaderHash,
      invitationId: context.get("uploadInvitationId"),
      createdAt: now,
      reservationExpiresAt: now + config.reservationTtlSeconds,
      fileExpiresAt: now + config.fileRetentionSeconds,
    },
    {
      reservationWindowSeconds: config.uploadReservationWindowSeconds,
      reservationLimit: config.uploadReservationLimit,
      hourlyWindowSeconds: config.uploadHourlyWindowSeconds,
      hourlyBytes: config.uploadHourlyBytes,
      dailyWindowSeconds: config.uploadDailyWindowSeconds,
      dailyBytes: config.uploadDailyBytes,
    },
  );

  console.log(
    JSON.stringify({
      level: "info",
      event: "upload.reserved",
      requestId: context.get("requestId"),
      fileId,
      sizeBytes: input.sizeBytes,
    }),
  );

  return context.json({
    uploadId: reservationId,
    uploadUrl: `/api/uploads/${reservationId}`,
    expiresAt: new Date((now + config.reservationTtlSeconds) * 1000).toISOString(),
  });
});

uploadRoutes.put("/uploads/:uploadId", async (context) => {
  const config = getConfig(context.env);
  const uploadId = context.req.param("uploadId");
  const initial = await getUploadRecord(context.env.DB, uploadId);
  if (initial === null) {
    throw new DomainError("RESERVATION_NOT_FOUND", 404, "找不到這筆上傳預留。");
  }
  if (initial.invitation_id !== context.get("uploadInvitationId")) {
    throw new DomainError("RESERVATION_NOT_FOUND", 404, "找不到這筆上傳預留。");
  }

  const contentLengthText = context.req.header("Content-Length");
  const contentLength = contentLengthText === undefined ? Number.NaN : Number(contentLengthText);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new DomainError("INVALID_REQUEST", 400, "上傳必須提供正確的 Content-Length。");
  }
  if (contentLength !== initial.reserved_bytes) {
    throw new DomainError("FILE_SIZE_MISMATCH", 400, "實際檔案大小與預留大小不符。");
  }
  const requestBody: unknown = context.req.raw.body;
  if (!isByteStream(requestBody)) {
    throw new DomainError("INVALID_REQUEST", 400, "上傳內容不可為空。");
  }

  const now = Math.floor(Date.now() / 1000);
  const claimed = await claimUpload(
    context.env.DB,
    uploadId,
    now,
    context.get("uploadInvitationId"),
  );
  let phase: "claimed" | "object_stored" | "ledger_committed" | "reservation_released" =
    "claimed";

  try {
    const peeked = await peekStream(requestBody);
    const classification = classifyFile(peeked.prefix, claimed.extension, claimed.declared_mime);
    if (classification.previewPolicy === "blocked") {
      await releaseReservation(context.env.DB, uploadId, now, "rejected", "cancelled");
      phase = "reservation_released";
      console.log(
        JSON.stringify({
          level: "info",
          event: "security.blocked_type",
          requestId: context.get("requestId"),
          fileId: claimed.id,
        }),
      );
      throw new DomainError("FILE_TYPE_BLOCKED", 400, "檔案內容屬於禁止上傳的類型。");
    }

    const deleteToken = createDeleteToken();
    const deleteTokenHash = await hashPepperedValue(context.env.DELETE_TOKEN_PEPPER, deleteToken);
    const stored = await storeObject(
      context.env.FILES,
      claimed,
      peeked.stream,
      classification.detectedMime,
      classification.previewPolicy,
      config.mediaPreviewCacheSeconds,
    );
    phase = "object_stored";

    if (stored.size !== claimed.reserved_bytes) {
      throw new DomainError("FILE_SIZE_MISMATCH", 400, "實際檔案大小與預留大小不符。");
    }

    const active = await completeUpload(context.env.DB, {
      uploadId,
      sizeBytes: stored.size,
      detectedMime: classification.detectedMime,
      previewPolicy: classification.previewPolicy,
      deleteTokenHash,
      now,
    });
    phase = "ledger_committed";
    if (
      active === null ||
      active.status !== "active" ||
      active.reservation_status !== "consumed"
    ) {
      throw new DomainError("UPLOAD_FAILED", 500, "無法讀取已完成的檔案資料。");
    }

    console.log(
      JSON.stringify({
        level: "info",
        event: "upload.completed",
        requestId: context.get("requestId"),
        fileId: active.id,
        sizeBytes: active.size_bytes,
        detectedMime: active.detected_mime,
      }),
    );

    return context.json({
      ...toPublicFile(active, getConfig(context.env)),
      deleteToken,
    });
  } catch (error) {
    if (phase === "ledger_committed") {
      console.error(
        JSON.stringify({
          level: "error",
          event: "upload.post_commit_failed",
          requestId: context.get("requestId"),
          fileId: claimed.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
    if (phase === "object_stored") {
      try {
        await context.env.FILES.delete(claimed.object_key);
      } catch (rollbackError) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "upload.rollback_object_failed",
            requestId: context.get("requestId"),
            fileId: claimed.id,
            message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          }),
        );
      }
    }
    if (phase !== "reservation_released") {
      try {
        await releaseReservation(context.env.DB, uploadId, now, "failed", "cancelled");
      } catch (rollbackError) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "upload.rollback_reservation_failed",
            requestId: context.get("requestId"),
            fileId: claimed.id,
            message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          }),
        );
      }
    }
    if (!(error instanceof DomainError && error.code === "FILE_TYPE_BLOCKED")) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "upload.failed",
          requestId: context.get("requestId"),
          fileId: claimed.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    throw error;
  }
});
