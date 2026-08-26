import type { FileRecord, FileStatus } from "../domain/file";
import { DomainError } from "../domain/errors";

function changes(result: D1Result): number {
  const value = result.meta.changes;
  return typeof value === "number" ? value : 0;
}

export async function getFile(database: D1Database, fileId: string): Promise<FileRecord | null> {
  return database.prepare("SELECT * FROM files WHERE id = ?1").bind(fileId).first<FileRecord>();
}

export async function getAccessibleFile(
  database: D1Database,
  fileId: string,
  now: number,
): Promise<FileRecord | null> {
  return database
    .prepare(
      `SELECT *
       FROM files
       WHERE id = ?1
         AND status = 'active'
         AND expires_at > ?2`,
    )
    .bind(fileId, now)
    .first<FileRecord>();
}

export async function claimDeletion(database: D1Database, fileId: string): Promise<FileRecord> {
  await database
    .prepare(
      `UPDATE files
       SET status = 'deleting'
       WHERE id = ?1
         AND status = 'active'`,
    )
    .bind(fileId)
    .run();

  const file = await getFile(database, fileId);
  if (file === null) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  return file;
}

export async function finalizeDeletion(
  database: D1Database,
  fileId: string,
  sizeBytes: number,
  now: number,
): Promise<void> {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE storage_usage
         SET used_bytes = MAX(0, used_bytes - ?1),
             updated_at = ?2
         WHERE id = 1
           AND EXISTS (
             SELECT 1
             FROM files
             WHERE id = ?3
               AND status = 'deleting'
               AND deleted_at IS NULL
           )`,
      )
      .bind(sizeBytes, now, fileId),
    database
      .prepare(
        `UPDATE files
         SET status = 'deleted',
             deleted_at = ?1
         WHERE id = ?2
           AND status = 'deleting'
           AND deleted_at IS NULL`,
      )
      .bind(now, fileId),
  ]);

  if (!results.every((result) => changes(result) === 1)) {
    const file = await getFile(database, fileId);
    if (file?.status === "deleted") {
      return;
    }
    throw new DomainError("INTERNAL_ERROR", 500, "無法完成檔案刪除帳本更新。");
  }
}

export async function markMissingObjectDeleted(
  database: D1Database,
  file: FileRecord,
  now: number,
): Promise<void> {
  const claim = await database
    .prepare(
      `UPDATE files
       SET status = 'deleting'
       WHERE id = ?1
         AND status = 'active'
         AND deleted_at IS NULL`,
    )
    .bind(file.id)
    .run();

  if (changes(claim) === 0) {
    return;
  }
  await finalizeDeletion(database, file.id, file.size_bytes, now);
}

export async function listFilesForCleanup(
  database: D1Database,
  now: number,
  limit: number,
): Promise<FileRecord[]> {
  const result = await database
    .prepare(
      `SELECT *
       FROM files
       WHERE (status = 'active' AND expires_at <= ?1)
          OR status = 'deleting'
       ORDER BY expires_at
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<FileRecord>();
  return result.results;
}

export async function purgeDeletedMetadata(database: D1Database, cutoff: number): Promise<number> {
  const result = await database
    .prepare(
      `DELETE FROM files
       WHERE status = 'deleted'
         AND deleted_at <= ?1`,
    )
    .bind(cutoff)
    .run();
  return changes(result);
}

export interface AdminFileFilter {
  readonly status: FileStatus | null;
  readonly mime: string | null;
  readonly createdBefore: number | null;
  readonly createdAfter: number | null;
  readonly expiresBefore: number | null;
  readonly expiresAfter: number | null;
  readonly cursorCreatedAt: number | null;
  readonly cursorId: string | null;
  readonly limit: number;
}

export async function listAdminFiles(
  database: D1Database,
  filter: AdminFileFilter,
): Promise<FileRecord[]> {
  const result = await database
    .prepare(
      `SELECT *
       FROM files
       WHERE (?1 IS NULL OR status = ?1)
         AND (?2 IS NULL OR detected_mime = ?2)
         AND (?3 IS NULL OR created_at < ?3)
         AND (?4 IS NULL OR created_at > ?4)
         AND (?5 IS NULL OR expires_at < ?5)
         AND (?6 IS NULL OR expires_at > ?6)
         AND (
           ?7 IS NULL
           OR created_at < ?7
           OR (created_at = ?7 AND id < ?8)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ?9`,
    )
    .bind(
      filter.status,
      filter.mime,
      filter.createdBefore,
      filter.createdAfter,
      filter.expiresBefore,
      filter.expiresAfter,
      filter.cursorCreatedAt,
      filter.cursorId,
      filter.limit,
    )
    .all<FileRecord>();
  return result.results;
}
