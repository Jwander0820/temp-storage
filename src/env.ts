import { DomainError } from "./domain/errors";

export interface AppConfig {
  readonly maxStorageBytes: number;
  readonly maxFileBytes: number;
  readonly fileRetentionSeconds: number;
  readonly reservationTtlSeconds: number;
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

export function getConfig(env: Env): AppConfig {
  return {
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
    uploadsEnabled: env.UPLOADS_ENABLED === "true",
    uploadOrigin: parseOrigin(env.UPLOAD_ORIGIN, "UPLOAD_ORIGIN"),
    cdnOrigin: parseOrigin(env.CDN_ORIGIN, "CDN_ORIGIN"),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  };
}
