import type {
  InvitationSession,
  InvitationStatus,
  InvitationUsage,
  UploadInvitation,
} from "../domain/invitation";
import { DomainError } from "../domain/errors";

export interface CreateInvitationInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly label: string;
  readonly maxFiles: number;
  readonly unlimitedFiles: boolean;
  readonly maxBytes: number;
  readonly canUpload: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly invitationId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface InvitationSummary extends UploadInvitation, InvitationUsage {}

const invitationSummarySql = `
  SELECT
    i.*,
    COUNT(e.id) AS used_files,
    COALESCE(SUM(e.size_bytes), 0) AS used_bytes
  FROM upload_invitations i
  LEFT JOIN rate_limit_events e ON e.invitation_id = i.id
`;

export async function createInvitation(
  database: D1Database,
  input: CreateInvitationInput,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO upload_invitations (
         id, token_hash, label, status, max_files, unlimited_files, max_bytes, can_upload,
         created_at, expires_at
       ) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      input.id,
      input.tokenHash,
      input.label,
      input.maxFiles,
      input.unlimitedFiles ? 1 : 0,
      input.maxBytes,
      input.canUpload ? 1 : 0,
      input.createdAt,
      input.expiresAt,
    )
    .run();
}

export async function getInvitationByTokenHash(
  database: D1Database,
  tokenHash: string,
  now: number,
): Promise<UploadInvitation | null> {
  return database
    .prepare(
      `SELECT i.*
       FROM upload_invitations i
       LEFT JOIN upload_invitation_tokens token ON token.invitation_id = i.id
       WHERE (i.token_hash = ?1 OR token.token_hash = ?1)
         AND i.status = 'active'
         AND i.expires_at > ?2
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first<UploadInvitation>();
}

export async function createSession(
  database: D1Database,
  input: CreateSessionInput,
): Promise<void> {
  const result = await database
    .prepare(
      `INSERT INTO upload_sessions (
         id, token_hash, invitation_id, created_at, expires_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (
         SELECT 1
         FROM upload_invitations
         WHERE id = ?3
           AND status = 'active'
           AND expires_at >= ?5
       )`,
    )
    .bind(input.id, input.tokenHash, input.invitationId, input.createdAt, input.expiresAt)
    .run();
  if (result.meta.changes !== 1) {
    throw new DomainError(
      "INVITATION_INVALID",
      403,
      "Invitation became invalid before the session was created.",
    );
  }
}

export async function getSessionByTokenHash(
  database: D1Database,
  tokenHash: string,
  now: number,
): Promise<InvitationSession | null> {
  return database
    .prepare(
      `SELECT
         i.*,
         s.id AS session_id,
         s.expires_at AS session_expires_at,
         COUNT(e.id) AS used_files,
         COALESCE(SUM(e.size_bytes), 0) AS used_bytes
       FROM upload_sessions s
       JOIN upload_invitations i ON i.id = s.invitation_id
       LEFT JOIN rate_limit_events e ON e.invitation_id = i.id
       WHERE s.token_hash = ?1
         AND s.revoked_at IS NULL
         AND s.expires_at > ?2
         AND i.status = 'active'
         AND i.expires_at > ?2
       GROUP BY i.id, s.id`,
    )
    .bind(tokenHash, now)
    .first<InvitationSession>();
}

export async function listInvitations(database: D1Database): Promise<InvitationSummary[]> {
  const result = await database
    .prepare(`${invitationSummarySql} GROUP BY i.id ORDER BY i.created_at DESC, i.id DESC`)
    .all<InvitationSummary>();
  return result.results;
}

export async function getInvitationSummary(
  database: D1Database,
  invitationId: string,
): Promise<InvitationSummary | null> {
  return database
    .prepare(`${invitationSummarySql} WHERE i.id = ?1 GROUP BY i.id`)
    .bind(invitationId)
    .first<InvitationSummary>();
}

export async function revokeInvitation(
  database: D1Database,
  invitationId: string,
  now: number,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE upload_invitations
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?1)
         WHERE id = ?2 AND status = 'active'`,
      )
      .bind(now, invitationId),
    database
      .prepare(
        `UPDATE upload_sessions
         SET revoked_at = COALESCE(revoked_at, ?1)
         WHERE invitation_id = ?2 AND revoked_at IS NULL`,
      )
      .bind(now, invitationId),
  ]);
}

export async function reissueInvitationToken(
  database: D1Database,
  invitationId: string,
  tokenHash: string,
  now: number,
): Promise<InvitationSummary | null> {
  const [updated] = await database.batch([
    database
      .prepare(
        `UPDATE upload_invitations
         SET token_hash = ?1
         WHERE id = ?2
           AND status = 'active'
           AND expires_at > ?3`,
      )
      .bind(tokenHash, invitationId, now),
    database
      .prepare(
        `DELETE FROM upload_invitation_tokens
         WHERE invitation_id = ?1
           AND EXISTS (
             SELECT 1
             FROM upload_invitations
             WHERE id = ?1
               AND status = 'active'
               AND expires_at > ?2
           )`,
      )
      .bind(invitationId, now),
    database
      .prepare(
        `UPDATE upload_sessions
         SET revoked_at = COALESCE(revoked_at, ?1)
         WHERE invitation_id = ?2 AND revoked_at IS NULL`,
      )
      .bind(now, invitationId),
  ]);

  if (updated?.meta.changes !== 1) {
    return null;
  }
  return getInvitationSummary(database, invitationId);
}

export async function issueAdditionalInvitationToken(
  database: D1Database,
  invitationId: string,
  tokenHash: string,
  now: number,
): Promise<InvitationSummary | null> {
  const inserted = await database
    .prepare(
      `INSERT INTO upload_invitation_tokens (token_hash, invitation_id, created_at)
       SELECT ?1, id, ?3
       FROM upload_invitations
       WHERE id = ?2
         AND status = 'active'
         AND expires_at > ?3`,
    )
    .bind(tokenHash, invitationId, now)
    .run();

  if (inserted.meta.changes !== 1) {
    return null;
  }
  return getInvitationSummary(database, invitationId);
}

export async function revokeSessionByTokenHash(
  database: D1Database,
  tokenHash: string,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `UPDATE upload_sessions
       SET revoked_at = COALESCE(revoked_at, ?1)
       WHERE token_hash = ?2 AND revoked_at IS NULL`,
    )
    .bind(now, tokenHash)
    .run();
}

export async function purgeExpiredSessions(database: D1Database, now: number): Promise<number> {
  const result = await database
    .prepare(
      `DELETE FROM upload_sessions
       WHERE expires_at <= ?1
          OR revoked_at IS NOT NULL
          OR invitation_id IN (
            SELECT id FROM upload_invitations
            WHERE status = 'revoked' OR expires_at <= ?1
          )`,
    )
    .bind(now)
    .run();
  return typeof result.meta.changes === "number" ? result.meta.changes : 0;
}

export function invitationStatus(
  invitation: UploadInvitation,
  now: number,
): InvitationStatus | "expired" {
  if (invitation.status === "revoked") {
    return "revoked";
  }
  return invitation.expires_at <= now ? "expired" : "active";
}
