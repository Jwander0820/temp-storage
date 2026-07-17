import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import type { ReserveUploadInput } from "../domain/upload";
import { getConfig } from "../env";
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
import { verifyOptionalAccessCode, verifyTurnstile } from "../services/turnstile-service";
import { getExtension, isBlockedExtension, sanitizeOriginalFilename } from "../utils/filename";
import { createDeleteToken, createFileId, hashPepperedValue } from "../utils/hash";
import { peekStream } from "../utils/stream";

function parseReserveInput(value: unknown): ReserveUploadInput {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("INVALID_REQUEST", 400, "上傳資料格式不正確。");
  }

  const record = value as Record<string, unknown>;
  const filename = record.filename;
  const sizeBytes = record.sizeBytes;
  const declaredMime = record.declaredMime;
  const turnstileToken = record.turnstileToken;
  const accessCode = record.accessCode;

  if (
    typeof filename !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof turnstileToken !== "string" ||
    (declaredMime !== undefined && declaredMime !== null && typeof declaredMime !== "string") ||
    (accessCode !== undefined && accessCode !== null && typeof accessCode !== "string")
  ) {
    throw new DomainError("INVALID_REQUEST", 400, "上傳資料格式不正確。");
  }

  return {
    filename,
    sizeBytes,
    declaredMime: declaredMime ?? null,
    turnstileToken,
    accessCode: accessCode ?? null,
  };
}

function dateBucket(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function objectKey(fileId: string, epochSeconds: number): string {
  const [year, month, day] = dateBucket(epochSeconds).split("-");
  return `objects/${year}/${month}/${day}/${fileId}`;
}

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

export const uploadRoutes = new Hono<AppEnv>();

uploadRoutes.post("/uploads/reserve", async (context) => {
  const config = getConfig(context.env);
  if (!config.uploadsEnabled) {
    throw new DomainError("UPLOADS_DISABLED", 503, "目前暫停接受新上傳。");
  }

  const input = parseReserveInput(await context.req.json<unknown>());
  const filename = sanitizeOriginalFilename(input.filename);
  if (filename.length === 0 || input.filename.length > 255) {
    throw new DomainError("INVALID_REQUEST", 400, "檔名長度不正確。");
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new DomainError("INVALID_REQUEST", 400, "檔案大小不正確。");
  }
  if (input.sizeBytes > config.maxFileBytes) {
    throw new DomainError("FILE_TOO_LARGE", 413, "單一檔案不可超過 50 MiB。");
  }

  const extension = getExtension(filename);
  if (isBlockedExtension(extension) || isBlockedDeclaredMime(input.declaredMime)) {
    throw new DomainError("FILE_TYPE_BLOCKED", 400, "這個檔案類型不允許上傳。");
  }

  await verifyOptionalAccessCode(context.env, input.accessCode);
  const remoteIp = context.req.header("CF-Connecting-IP") ?? "local-development";
  await verifyTurnstile(context.env, input.turnstileToken, remoteIp);

  const now = Math.floor(Date.now() / 1000);
  const previousDay = now - 86400;
  const [uploaderHash, previousUploaderHash] = await Promise.all([
    hashPepperedValue(context.env.IP_HASH_PEPPER, `${dateBucket(now)}\u0000${remoteIp}`),
    hashPepperedValue(context.env.IP_HASH_PEPPER, `${dateBucket(previousDay)}\u0000${remoteIp}`),
  ]);

  const fileId = createFileId();
  const reservationId = fileId;
  await reserveQuotaAndCreateRecords(context.env.DB, {
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
    createdAt: now,
    reservationExpiresAt: now + config.reservationTtlSeconds,
    fileExpiresAt: now + config.fileRetentionSeconds,
  });

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
  const uploadId = context.req.param("uploadId");
  const initial = await getUploadRecord(context.env.DB, uploadId);
  if (initial === null) {
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
  const claimed = await claimUpload(context.env.DB, uploadId, now);
  let objectStored = false;

  try {
    const peeked = await peekStream(requestBody);
    const classification = classifyFile(peeked.prefix, claimed.extension, claimed.declared_mime);
    if (classification.previewPolicy === "blocked") {
      await releaseReservation(context.env.DB, uploadId, now, "rejected", "cancelled");
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
    );
    objectStored = true;

    if (stored.size !== claimed.reserved_bytes) {
      await context.env.FILES.delete(claimed.object_key);
      objectStored = false;
      await releaseReservation(context.env.DB, uploadId, now, "failed", "cancelled");
      throw new DomainError("FILE_SIZE_MISMATCH", 400, "實際檔案大小與預留大小不符。");
    }

    await completeUpload(context.env.DB, {
      uploadId,
      sizeBytes: stored.size,
      detectedMime: classification.detectedMime,
      previewPolicy: classification.previewPolicy,
      deleteTokenHash,
      now,
    });

    const active = await getUploadRecord(context.env.DB, uploadId);
    if (active === null) {
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
    if (objectStored) {
      await context.env.FILES.delete(claimed.object_key);
    }
    await releaseReservation(context.env.DB, uploadId, now, "failed", "cancelled");
    console.error(
      JSON.stringify({
        level: "error",
        event: "upload.failed",
        requestId: context.get("requestId"),
        fileId: claimed.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
});
