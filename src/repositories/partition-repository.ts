import { DomainError } from "../domain/errors";
import type { CreateInvitationInput } from "./invitation-repository";

export interface PrivatePartition {
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "revoked";
  readonly max_files: number;
  readonly unlimited_files: 0 | 1;
  readonly max_bytes: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
  readonly used_files: number;
  readonly used_bytes: number;
  readonly credential_count: number;
  readonly pending_files: number;
}

export interface PartitionPolicy {
  readonly label: string;
  readonly expiresAt: number;
  readonly maxFiles: number;
  readonly unlimitedFiles: boolean;
  readonly maxBytes: number;
}

export async function listPartitions(
  database: D1Database,
  now: number,
): Promise<PrivatePartition[]> {
  const result = await database
    .prepare(
      `
    SELECT p.*,
      (SELECT COUNT(*) FROM rate_limit_events e JOIN upload_invitations i ON i.id = e.invitation_id WHERE i.partition_id = p.id) AS used_files,
      COALESCE((SELECT SUM(e.size_bytes) FROM rate_limit_events e JOIN upload_invitations i ON i.id = e.invitation_id WHERE i.partition_id = p.id), 0) AS used_bytes,
      (SELECT COUNT(*) FROM upload_invitations i WHERE i.partition_id = p.id AND i.status = 'active' AND p.status = 'active' AND p.expires_at > ?1) AS credential_count,
      (SELECT COUNT(*) FROM files f WHERE f.partition_id = p.id AND f.status IN ('active', 'deleting', 'reserved', 'uploading', 'failed', 'rejected')) AS pending_files
    FROM private_partitions p ORDER BY p.created_at DESC, p.id DESC
  `,
    )
    .bind(now)
    .all<PrivatePartition>();
  return result.results;
}

// Creating the partition and its first credential is one transaction. Issuing
// another credential reads the live policy in the same atomic INSERT.
export async function createPartitionCredential(
  database: D1Database,
  partitionId: string,
  input: CreateInvitationInput,
  newPartition: PartitionPolicy | null,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (newPartition !== null) {
    statements.push(
      database
        .prepare(
          `INSERT INTO private_partitions
      (id, label, max_files, unlimited_files, max_bytes, created_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          partitionId,
          newPartition.label,
          newPartition.maxFiles,
          newPartition.unlimitedFiles ? 1 : 0,
          newPartition.maxBytes,
          input.createdAt,
          newPartition.expiresAt,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO upload_invitations
    (id, token_hash, label, status, max_files, unlimited_files, max_bytes, can_upload, created_at, expires_at, partition_id)
    SELECT ?1, ?2, ?3, 'active', p.max_files, p.unlimited_files, p.max_bytes, ?4, ?5, p.expires_at, p.id
    FROM private_partitions p WHERE p.id = ?6 AND p.status = 'active' AND p.expires_at > ?5`,
      )
      .bind(
        input.id,
        input.tokenHash,
        input.label,
        input.canUpload ? 1 : 0,
        input.createdAt,
        partitionId,
      ),
  );
  const results = await database.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) {
    throw new DomainError(
      "INVITATION_INVALID",
      409,
      "私密分區已到期或進入刪除程序，請建立新分區。",
    );
  }
}

export async function updatePartition(
  database: D1Database,
  id: string,
  policy: PartitionPolicy,
  now: number,
): Promise<void> {
  const result = await database
    .prepare(
      `UPDATE private_partitions
    SET label = ?1, expires_at = ?2, max_files = ?3, unlimited_files = ?4, max_bytes = ?5
    WHERE id = ?6 AND status = 'active' AND expires_at > ?7`,
    )
    .bind(
      policy.label,
      policy.expiresAt,
      policy.maxFiles,
      policy.unlimitedFiles ? 1 : 0,
      policy.maxBytes,
      id,
      now,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new DomainError("INVITATION_INVALID", 409, "只能修改尚未到期的有效私密分區。");
  }
}

export function closePartitionStatement(
  database: D1Database,
  now: number,
  id: string | null = null,
  force = false,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE private_partitions SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?1)
    WHERE status = 'active' AND (?2 IS NULL OR id = ?2)
      AND (?3 = 1 OR expires_at <= ?1 OR NOT EXISTS (
        SELECT 1 FROM upload_invitations i WHERE i.partition_id = private_partitions.id AND i.status = 'active'
      ))`,
    )
    .bind(now, id, force ? 1 : 0);
}

export async function closePartitions(
  database: D1Database,
  now: number,
  id: string | null = null,
  force = false,
): Promise<void> {
  await database.batch([
    closePartitionStatement(database, now, id, force),
    database
      .prepare(
        `UPDATE upload_invitations SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?1)
      WHERE status = 'active' AND partition_id IN (SELECT id FROM private_partitions WHERE status = 'revoked')`,
      )
      .bind(now),
    database
      .prepare(
        `UPDATE upload_sessions SET revoked_at = COALESCE(revoked_at, ?1)
      WHERE revoked_at IS NULL AND invitation_id IN (
        SELECT i.id FROM upload_invitations i JOIN private_partitions p ON p.id = i.partition_id WHERE p.status = 'revoked'
      )`,
      )
      .bind(now),
  ]);
}
