import type { FileRecord, FileStatus, PreviewPolicy } from "../domain/file";
import type { UploadReservation, ReservationStatus } from "../domain/upload";
import { DomainError } from "../domain/errors";

export interface UploadRecord extends FileRecord {
  readonly reservation_id: string;
  readonly reserved_bytes: number;
  readonly reservation_status: ReservationStatus;
  readonly reservation_expires_at: number;
  readonly quota_released_at: number | null;
}

function changes(result: D1Result): number {
  const value = result.meta.changes;
  return typeof value === "number" ? value : 0;
}

export async function getUploadRecord(
  database: D1Database,
  uploadId: string,
): Promise<UploadRecord | null> {
  return database
    .prepare(
      `SELECT
         f.*,
         r.id AS reservation_id,
         r.reserved_bytes,
         r.status AS reservation_status,
         r.expires_at AS reservation_expires_at,
         r.quota_released_at
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       WHERE r.id = ?1`,
    )
    .bind(uploadId)
    .first<UploadRecord>();
}

export async function claimUpload(
  database: D1Database,
  uploadId: string,
  now: number,
): Promise<UploadRecord> {
  const result = await database
    .prepare(
      `UPDATE files
       SET status = 'uploading'
       WHERE id = (
         SELECT file_id
         FROM upload_reservations
         WHERE id = ?1
           AND status = 'reserved'
           AND expires_at > ?2
           AND quota_released_at IS NULL
       )
       AND status = 'reserved'`,
    )
    .bind(uploadId, now)
    .run();

  if (changes(result) === 1) {
    const claimed = await getUploadRecord(database, uploadId);
    if (claimed !== null) {
      return claimed;
    }
    throw new DomainError("INTERNAL_ERROR", 500, "Claimed upload could not be loaded.");
  }

  const existing = await getUploadRecord(database, uploadId);
  if (existing === null) {
    throw new DomainError("RESERVATION_NOT_FOUND", 404, "找不到這筆上傳預留。");
  }
  if (existing.reservation_expires_at <= now || existing.reservation_status === "expired") {
    throw new DomainError("RESERVATION_EXPIRED", 409, "上傳預留已過期，請重新選擇檔案。");
  }
  throw new DomainError("RESERVATION_ALREADY_USED", 409, "這筆上傳預留已被使用。");
}

export async function releaseReservation(
  database: D1Database,
  uploadId: string,
  now: number,
  fileStatus: Extract<FileStatus, "rejected" | "failed">,
  reservationStatus: Extract<ReservationStatus, "cancelled" | "expired">,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = MAX(0, reserved_bytes - (
               SELECT reserved_bytes FROM upload_reservations WHERE id = ?1
             )),
             updated_at = ?2
         WHERE id = 1
           AND EXISTS (
             SELECT 1
             FROM upload_reservations
             WHERE id = ?1
               AND status = 'reserved'
               AND quota_released_at IS NULL
           )`,
      )
      .bind(uploadId, now),
    database
      .prepare(
        `UPDATE upload_reservations
         SET status = ?1,
             quota_released_at = COALESCE(quota_released_at, ?2)
         WHERE id = ?3
           AND status = 'reserved'
           AND quota_released_at IS NULL`,
      )
      .bind(reservationStatus, now, uploadId),
    database
      .prepare(
        `UPDATE files
         SET status = ?1
         WHERE id = (
           SELECT file_id FROM upload_reservations WHERE id = ?2
         )
         AND status IN ('reserved', 'uploading')`,
      )
      .bind(fileStatus, uploadId),
  ]);
}

export interface CompleteUploadInput {
  readonly uploadId: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly previewPolicy: Exclude<PreviewPolicy, "blocked">;
  readonly deleteTokenHash: string;
  readonly now: number;
}

export async function completeUpload(
  database: D1Database,
  input: CompleteUploadInput,
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = reserved_bytes - ?1,
             used_bytes = used_bytes + ?1,
             updated_at = ?2
         WHERE id = 1
           AND reserved_bytes >= ?1
           AND EXISTS (
             SELECT 1
             FROM upload_reservations r
             JOIN files f ON f.id = r.file_id
             WHERE r.id = ?3
               AND r.status = 'reserved'
               AND r.quota_released_at IS NULL
               AND f.status = 'uploading'
           )`,
      )
      .bind(input.sizeBytes, input.now, input.uploadId),
    database
      .prepare(
        `UPDATE upload_reservations
         SET status = 'consumed',
             quota_released_at = ?1
         WHERE id = ?2
           AND status = 'reserved'
           AND quota_released_at IS NULL`,
      )
      .bind(input.now, input.uploadId),
    database
      .prepare(
        `UPDATE files
         SET detected_mime = ?1,
             preview_policy = ?2,
             delete_token_hash = ?3,
             status = 'active'
         WHERE id = (
           SELECT file_id
           FROM upload_reservations
           WHERE id = ?4
             AND status = 'consumed'
         )
         AND status = 'uploading'`,
      )
      .bind(input.detectedMime, input.previewPolicy, input.deleteTokenHash, input.uploadId),
  ]);

  if (!results.every((result) => changes(result) === 1)) {
    throw new DomainError("UPLOAD_FAILED", 500, "無法完成上傳帳本更新。");
  }
}

export async function listExpiredReservations(
  database: D1Database,
  now: number,
  limit: number,
): Promise<UploadReservation[]> {
  const result = await database
    .prepare(
      `SELECT *
       FROM upload_reservations
       WHERE status = 'reserved'
         AND expires_at <= ?1
       ORDER BY expires_at
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<UploadReservation>();
  return result.results;
}
