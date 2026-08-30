import { DomainError } from "./domain/errors";

const ADMIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}$/u;

export interface AppConfig {
  readonly maxStorageBytes: number;
  readonly maxFileBytes: number;
  readonly fileRetentionSeconds: number;
  readonly reservationTtlSeconds: number;
  readonly uploadReservationWindowSeconds: number;
  readonly uploadReservationLimit: number;
  readonly uploadHourlyWindowSeconds: number;
  readonly uploadHourlyBytes: number;
  readonly uploadDailyWindowSeconds: number;
  readonly uploadDailyBytes: number;
  readonly invitationMinTtlSeconds: number;
  readonly invitationDefaultTtlSeconds: number;
  readonly invitationMaxTtlSeconds: number;
  readonly invitationDefaultMaxFiles: number;
  readonly invitationMaxFiles: number;
  readonly invitationDefaultMaxBytes: number;
  readonly uploadSessionTtlSeconds: number;
  readonly adminSessionTtlSeconds: number;
  readonly clientMaxFilesPerBatch: number;
  readonly clientMaxParallelUploads: number;
  readonly mediaPreviewCacheSeconds: number;
  readonly publicConfigCacheSeconds: number;
  readonly cleanupBatchLimit: number;
  readonly deletedMetadataRetentionSeconds: number;
  readonly failedUploadMetadataRetentionSeconds: number;
  readonly cleanupRunRetentionSeconds: number;
  readonly invitationHistoryRetentionSeconds: number;
  readonly reconcileMetadataLimit: number;
  readonly reconcileObjectLimit: number;
  readonly reconcilePageBudget: number;
  readonly reconcileOrphanGraceSeconds: number;
  readonly uploadsEnabled: boolean;
  readonly uploadOrigin: string;
  readonly cdnOrigin: string;
  readonly turnstileSiteKey: string;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DomainError("INTERNAL_ERROR", 500, `Invalid ${name} configuration.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DomainError("INTERNAL_ERROR", 500, `Invalid ${name} configuration.`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new DomainError("INTERNAL_ERROR", 500, `Invalid ${name} configuration.`);
}

function invalidRelationship(message: string): never {
  throw new DomainError("INTERNAL_ERROR", 500, `Invalid configuration: ${message}.`);
}

function parseOrigin(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("Origin must use HTTPS.");
    }
    return url.origin;
  } catch {
    throw new DomainError("INTERNAL_ERROR", 500, `Invalid ${name} configuration.`);
  }
}

export function assertValidAdminToken(value: string | undefined): asserts value is string {
  if (value === undefined || !ADMIN_TOKEN_PATTERN.test(value)) {
    throw new DomainError("INTERNAL_ERROR", 500, "Invalid ADMIN_TOKEN configuration.");
  }
}

export function getConfig(env: Env): AppConfig {
  const config: AppConfig = {
    maxStorageBytes: parsePositiveInteger(env.MAX_STORAGE_BYTES, "MAX_STORAGE_BYTES"),
    maxFileBytes: parsePositiveInteger(env.MAX_FILE_BYTES, "MAX_FILE_BYTES"),
    fileRetentionSeconds: parsePositiveInteger(
      env.FILE_RETENTION_SECONDS,
      "FILE_RETENTION_SECONDS",
    ),
    reservationTtlSeconds: parsePositiveInteger(
      env.RESERVATION_TTL_SECONDS,
      "RESERVATION_TTL_SECONDS",
    ),
    uploadReservationWindowSeconds: parsePositiveInteger(
      env.UPLOAD_RESERVATION_WINDOW_SECONDS,
      "UPLOAD_RESERVATION_WINDOW_SECONDS",
    ),
    uploadReservationLimit: parsePositiveInteger(
      env.UPLOAD_RESERVATION_LIMIT,
      "UPLOAD_RESERVATION_LIMIT",
    ),
    uploadHourlyWindowSeconds: parsePositiveInteger(
      env.UPLOAD_HOURLY_WINDOW_SECONDS,
      "UPLOAD_HOURLY_WINDOW_SECONDS",
    ),
    uploadHourlyBytes: parsePositiveInteger(env.UPLOAD_HOURLY_BYTES, "UPLOAD_HOURLY_BYTES"),
    uploadDailyWindowSeconds: parsePositiveInteger(
      env.UPLOAD_DAILY_WINDOW_SECONDS,
      "UPLOAD_DAILY_WINDOW_SECONDS",
    ),
    uploadDailyBytes: parsePositiveInteger(env.UPLOAD_DAILY_BYTES, "UPLOAD_DAILY_BYTES"),
    invitationMinTtlSeconds: parsePositiveInteger(
      env.INVITATION_MIN_TTL_SECONDS,
      "INVITATION_MIN_TTL_SECONDS",
    ),
    invitationDefaultTtlSeconds: parsePositiveInteger(
      env.INVITATION_DEFAULT_TTL_SECONDS,
      "INVITATION_DEFAULT_TTL_SECONDS",
    ),
    invitationMaxTtlSeconds: parsePositiveInteger(
      env.INVITATION_MAX_TTL_SECONDS,
      "INVITATION_MAX_TTL_SECONDS",
    ),
    invitationDefaultMaxFiles: parsePositiveInteger(
      env.INVITATION_DEFAULT_MAX_FILES,
      "INVITATION_DEFAULT_MAX_FILES",
    ),
    invitationMaxFiles: parsePositiveInteger(env.INVITATION_MAX_FILES, "INVITATION_MAX_FILES"),
    invitationDefaultMaxBytes: parsePositiveInteger(
      env.INVITATION_DEFAULT_MAX_BYTES,
      "INVITATION_DEFAULT_MAX_BYTES",
    ),
    uploadSessionTtlSeconds: parsePositiveInteger(
      env.UPLOAD_SESSION_TTL_SECONDS,
      "UPLOAD_SESSION_TTL_SECONDS",
    ),
    adminSessionTtlSeconds: parsePositiveInteger(
      env.ADMIN_SESSION_TTL_SECONDS,
      "ADMIN_SESSION_TTL_SECONDS",
    ),
    clientMaxFilesPerBatch: parsePositiveInteger(
      env.CLIENT_MAX_FILES_PER_BATCH,
      "CLIENT_MAX_FILES_PER_BATCH",
    ),
    clientMaxParallelUploads: parsePositiveInteger(
      env.CLIENT_MAX_PARALLEL_UPLOADS,
      "CLIENT_MAX_PARALLEL_UPLOADS",
    ),
    mediaPreviewCacheSeconds: parseNonNegativeInteger(
      env.MEDIA_PREVIEW_CACHE_SECONDS,
      "MEDIA_PREVIEW_CACHE_SECONDS",
    ),
    publicConfigCacheSeconds: parseNonNegativeInteger(
      env.PUBLIC_CONFIG_CACHE_SECONDS,
      "PUBLIC_CONFIG_CACHE_SECONDS",
    ),
    cleanupBatchLimit: parsePositiveInteger(env.CLEANUP_BATCH_LIMIT, "CLEANUP_BATCH_LIMIT"),
    deletedMetadataRetentionSeconds: parseNonNegativeInteger(
      env.DELETED_METADATA_RETENTION_SECONDS,
      "DELETED_METADATA_RETENTION_SECONDS",
    ),
    failedUploadMetadataRetentionSeconds: parseNonNegativeInteger(
      env.FAILED_UPLOAD_METADATA_RETENTION_SECONDS,
      "FAILED_UPLOAD_METADATA_RETENTION_SECONDS",
    ),
    cleanupRunRetentionSeconds: parsePositiveInteger(
      env.CLEANUP_RUN_RETENTION_SECONDS,
      "CLEANUP_RUN_RETENTION_SECONDS",
    ),
    invitationHistoryRetentionSeconds: parsePositiveInteger(
      env.INVITATION_HISTORY_RETENTION_SECONDS,
      "INVITATION_HISTORY_RETENTION_SECONDS",
    ),
    reconcileMetadataLimit: parsePositiveInteger(
      env.RECONCILE_METADATA_LIMIT,
      "RECONCILE_METADATA_LIMIT",
    ),
    reconcileObjectLimit: parsePositiveInteger(
      env.RECONCILE_OBJECT_LIMIT,
      "RECONCILE_OBJECT_LIMIT",
    ),
    reconcilePageBudget: parsePositiveInteger(env.RECONCILE_PAGE_BUDGET, "RECONCILE_PAGE_BUDGET"),
    reconcileOrphanGraceSeconds: parseNonNegativeInteger(
      env.RECONCILE_ORPHAN_GRACE_SECONDS,
      "RECONCILE_ORPHAN_GRACE_SECONDS",
    ),
    uploadsEnabled: parseBoolean(env.UPLOADS_ENABLED, "UPLOADS_ENABLED"),
    uploadOrigin: parseOrigin(env.UPLOAD_ORIGIN, "UPLOAD_ORIGIN"),
    cdnOrigin: parseOrigin(env.CDN_ORIGIN, "CDN_ORIGIN"),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  };

  if (
    config.uploadReservationWindowSeconds > config.uploadHourlyWindowSeconds ||
    config.uploadHourlyWindowSeconds > config.uploadDailyWindowSeconds ||
    config.uploadDailyWindowSeconds > 86_400
  ) {
    invalidRelationship("upload rate-limit windows must increase and stay within 24 hours");
  }
  if (
    config.maxFileBytes > config.uploadHourlyBytes ||
    config.uploadHourlyBytes > config.uploadDailyBytes
  ) {
    invalidRelationship(
      "upload byte limits must accommodate MAX_FILE_BYTES and increase by window",
    );
  }
  if (
    config.invitationMinTtlSeconds > config.invitationDefaultTtlSeconds ||
    config.invitationDefaultTtlSeconds > config.invitationMaxTtlSeconds
  ) {
    invalidRelationship("invitation TTL values must satisfy min <= default <= max");
  }
  if (config.invitationDefaultMaxFiles > config.invitationMaxFiles) {
    invalidRelationship("invitation file defaults must not exceed the maximum");
  }
  if (config.invitationDefaultMaxBytes > config.maxStorageBytes) {
    invalidRelationship("default invitation bytes must not exceed total storage");
  }
  if (config.uploadSessionTtlSeconds > config.invitationMaxTtlSeconds) {
    invalidRelationship("upload session TTL must not exceed the maximum invitation TTL");
  }
  if (config.clientMaxParallelUploads > config.clientMaxFilesPerBatch) {
    invalidRelationship("parallel uploads must not exceed the client batch size");
  }
  if (config.reconcileObjectLimit > 1_000) {
    invalidRelationship("R2 reconciliation object limit must not exceed 1000");
  }
  return config;
}
