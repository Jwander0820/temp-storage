import type { Bindings } from "../bindings";
import type { FileRecord } from "../domain/file";
import type { PrivatePartition } from "../repositories/partition-repository";
import { releaseReservation } from "../repositories/upload-repository";
import { deleteFileAsAdmin } from "./deletion-service";

export function partitionPayload(partition: PrivatePartition, now: number) {
  return {
    id: partition.id,
    label: partition.label,
    status:
      partition.status === "revoked"
        ? "revoked"
        : partition.expires_at <= now
          ? "expired"
          : "active",
    maxFiles: partition.max_files,
    unlimitedFiles: partition.unlimited_files === 1,
    maxBytes: partition.max_bytes,
    usedFiles: partition.used_files,
    usedBytes: partition.used_bytes,
    credentialCount: partition.credential_count,
    pendingFiles: partition.pending_files,
    createdAt: new Date(partition.created_at * 1000).toISOString(),
    expiresAt: new Date(partition.expires_at * 1000).toISOString(),
  };
}

// Bounded, retryable work; the regular cleanup resumes any remaining files.
export async function cleanClosedPartition(
  env: Pick<Bindings, "DB" | "FILES">,
  id: string,
  now: number,
) {
  const files = await env.DB.prepare(
    `SELECT f.* FROM files f JOIN private_partitions p ON p.id = f.partition_id
    WHERE p.id = ?1 AND p.status = 'revoked' AND f.status IN ('active', 'deleting', 'reserved', 'uploading', 'failed', 'rejected')
    ORDER BY f.created_at, f.id LIMIT 100`,
  )
    .bind(id)
    .all<FileRecord>();
  let failed = 0;
  for (const file of files.results) {
    try {
      if (file.status === "reserved" || file.status === "uploading") {
        const reservation = await env.DB.prepare(
          "SELECT id FROM upload_reservations WHERE file_id = ?1",
        )
          .bind(file.id)
          .first<{ id: string }>();
        if (reservation !== null)
          await releaseReservation(env.DB, reservation.id, now, "failed", "cancelled");
        await deleteFileAsAdmin(env, file.id, now);
      } else {
        await deleteFileAsAdmin(env, file.id, now);
      }
    } catch {
      failed += 1;
    }
  }
  return { processed: files.results.length - failed, failed };
}
