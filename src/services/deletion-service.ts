import type { Bindings } from "../bindings";
import { DomainError } from "../domain/errors";
import { claimDeletion, finalizeDeletion, getFile } from "../repositories/file-repository";
import { isRandomToken32, verifyPepperedValue } from "../utils/hash";

export async function deleteFileWithToken(
  env: Bindings,
  fileId: string,
  token: string,
  now: number,
): Promise<void> {
  if (!isRandomToken32(token)) {
    throw new DomainError("INVALID_DELETE_TOKEN", 403, "刪除憑證不正確。");
  }
  const existing = await getFile(env.DB, fileId);
  if (existing === null) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  if (
    existing.delete_token_hash === null ||
    !(await verifyPepperedValue(env.DELETE_TOKEN_PEPPER, token, existing.delete_token_hash))
  ) {
    throw new DomainError("INVALID_DELETE_TOKEN", 403, "刪除憑證不正確。");
  }
  await deleteFileAsAdmin(env, fileId, now);
}

export async function deleteFileAsAdmin(
  env: Pick<Bindings, "DB" | "FILES">,
  fileId: string,
  now: number,
): Promise<void> {
  const file = await claimDeletion(env.DB, fileId);
  if (file.status === "deleted") {
    return;
  }
  // A closed private partition also owns any object left by a failed upload
  // rollback. Its reservation was already released, so do not debit used_bytes.
  if ((file.status === "failed" || file.status === "rejected") && file.partition_id) {
    const closed = await env.DB.prepare(
      `SELECT 1 FROM private_partitions p
      WHERE p.id = ?1 AND p.status = 'revoked' AND NOT EXISTS (
        SELECT 1 FROM upload_reservations r WHERE r.file_id = ?2 AND r.quota_released_at IS NULL
      )`,
    )
      .bind(file.partition_id, file.id)
      .first();
    if (closed !== null) {
      await env.FILES.delete(file.object_key);
      await env.DB.prepare(
        "UPDATE files SET status = 'deleted', deleted_at = ?1 WHERE id = ?2 AND status IN ('failed', 'rejected')",
      )
        .bind(now, file.id)
        .run();
      return;
    }
  }
  if (file.status !== "deleting") {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到可刪除的檔案。");
  }

  await env.FILES.delete(file.object_key);
  await finalizeDeletion(env.DB, file.id, file.size_bytes, now);
}
