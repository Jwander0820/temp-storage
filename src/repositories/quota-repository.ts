import type { StorageUsage } from "../domain/quota";
import { DomainError } from "../domain/errors";

export interface ReservationWrite {
  readonly eventId: string;
  readonly reservationId: string;
  readonly fileId: string;
  readonly objectKey: string;
  readonly filename: string;
  readonly extension: string | null;
  readonly declaredMime: string | null;
  readonly sizeBytes: number;
  readonly uploaderHash: string;
  readonly previousUploaderHash: string;
  readonly invitationId: string;
  readonly createdAt: number;
  readonly reservationExpiresAt: number;
  readonly fileExpiresAt: number;
}

const TEN_MINUTE_RESERVATION_LIMIT = 10;
const HOURLY_BYTE_LIMIT = 100 * 1024 * 1024;
const DAILY_BYTE_LIMIT = 300 * 1024 * 1024;

function changes(result: D1Result): number {
  const value = result.meta.changes;
  return typeof value === "number" ? value : 0;
}

export async function getStorageUsage(database: D1Database): Promise<StorageUsage> {
  const usage = await database
    .prepare(
      `SELECT used_bytes, reserved_bytes, max_bytes, updated_at
       FROM storage_usage
       WHERE id = 1`,
    )
    .first<StorageUsage>();

  if (usage === null) {
    throw new DomainError("INTERNAL_ERROR", 500, "Storage usage row is missing.");
  }
  return usage;
}

export async function reserveQuotaAndCreateRecords(
  database: D1Database,
  input: ReservationWrite,
): Promise<void> {
  const tenMinutesAgo = input.createdAt - 600;
  const hourAgo = input.createdAt - 3600;
  const dayAgo = input.createdAt - 86400;

  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO rate_limit_events (
           id, uploader_hash, size_bytes, created_at, invitation_id
         )
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE (
           SELECT COUNT(*)
           FROM rate_limit_events
           WHERE uploader_hash IN (?2, ?6)
             AND created_at >= ?7
         ) < ${TEN_MINUTE_RESERVATION_LIMIT}
         AND COALESCE((
           SELECT SUM(size_bytes)
           FROM rate_limit_events
           WHERE uploader_hash IN (?2, ?6)
             AND created_at >= ?8
         ), 0) + ?3 <= ${HOURLY_BYTE_LIMIT}
         AND COALESCE((
           SELECT SUM(size_bytes)
           FROM rate_limit_events
           WHERE uploader_hash IN (?2, ?6)
             AND created_at >= ?9
         ), 0) + ?3 <= ${DAILY_BYTE_LIMIT}
         AND EXISTS (
           SELECT 1
           FROM upload_invitations invitation
           WHERE invitation.id = ?5
             AND invitation.status = 'active'
             AND invitation.expires_at > ?4
             AND (
               SELECT COUNT(*)
               FROM rate_limit_events
               WHERE invitation_id = ?5
             ) < invitation.max_files
             AND COALESCE((
               SELECT SUM(size_bytes)
               FROM rate_limit_events
               WHERE invitation_id = ?5
             ), 0) + ?3 <= invitation.max_bytes
         )
         AND EXISTS (
           SELECT 1
           FROM storage_usage
           WHERE id = 1
             AND used_bytes + reserved_bytes + ?3 <= max_bytes
         )`,
      )
      .bind(
        input.eventId,
        input.uploaderHash,
        input.sizeBytes,
        input.createdAt,
        input.invitationId,
        input.previousUploaderHash,
        tenMinutesAgo,
        hourAgo,
        dayAgo,
      ),
    database
      .prepare(
        `INSERT INTO files (
           id, object_key, original_name, extension, declared_mime,
           size_bytes, status, created_at, expires_at, uploader_hash, invitation_id
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7, ?8, ?9, ?10
         WHERE EXISTS (
           SELECT 1 FROM rate_limit_events WHERE id = ?11
         )`,
      )
      .bind(
        input.fileId,
        input.objectKey,
        input.filename,
        input.extension,
        input.declaredMime,
        input.sizeBytes,
        input.createdAt,
        input.fileExpiresAt,
        input.uploaderHash,
        input.invitationId,
        input.eventId,
      ),
    database
      .prepare(
        `INSERT INTO upload_reservations (
           id, file_id, reserved_bytes, status, created_at, expires_at, invitation_id
         )
         SELECT ?1, ?2, ?3, 'reserved', ?4, ?5, ?6
         WHERE EXISTS (
           SELECT 1 FROM files WHERE id = ?2 AND status = 'reserved'
         )`,
      )
      .bind(
        input.reservationId,
        input.fileId,
        input.sizeBytes,
        input.createdAt,
        input.reservationExpiresAt,
        input.invitationId,
      ),
    database
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = reserved_bytes + ?1,
             updated_at = ?2
         WHERE id = 1
           AND EXISTS (
             SELECT 1
             FROM upload_reservations
             WHERE id = ?3
               AND status = 'reserved'
           )`,
      )
      .bind(input.sizeBytes, input.createdAt, input.reservationId),
  ]);

  const resultChanges = results.map(changes);
  if (resultChanges.every((value) => value === 1)) {
    return;
  }
  if (resultChanges.some((value) => value !== 0)) {
    throw new DomainError("INTERNAL_ERROR", 500, "Reservation transaction was inconsistent.");
  }

  const usage = await getStorageUsage(database);
  if (usage.used_bytes + usage.reserved_bytes + input.sizeBytes > usage.max_bytes) {
    throw new DomainError("STORAGE_LIMIT_EXCEEDED", 507, "暫存區容量已滿，請等待舊檔案清除。");
  }

  const invitation = await database
    .prepare(
      `SELECT
         status,
         expires_at,
         max_files,
         max_bytes,
         (SELECT COUNT(*) FROM rate_limit_events WHERE invitation_id = ?1) AS used_files,
         COALESCE((
           SELECT SUM(size_bytes) FROM rate_limit_events WHERE invitation_id = ?1
         ), 0) AS used_bytes
       FROM upload_invitations
       WHERE id = ?1`,
    )
    .bind(input.invitationId)
    .first<{
      status: "active" | "revoked";
      expires_at: number;
      max_files: number;
      max_bytes: number;
      used_files: number;
      used_bytes: number;
    }>();
  if (
    invitation === null ||
    invitation.status !== "active" ||
    invitation.expires_at <= input.createdAt
  ) {
    throw new DomainError("INVITATION_INVALID", 403, "邀請已失效，請向分享者取得新連結。");
  }
  if (
    invitation.used_files >= invitation.max_files ||
    invitation.used_bytes + input.sizeBytes > invitation.max_bytes
  ) {
    throw new DomainError("INVITATION_LIMIT_EXCEEDED", 429, "這份邀請的上傳額度已用完。");
  }

  throw new DomainError("RATE_LIMITED", 429, "上傳頻率過高，請稍後再試。");
}
