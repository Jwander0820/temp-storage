export interface CreateAdminSessionInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export async function createAdminSession(
  database: D1Database,
  input: CreateAdminSessionInput,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO admin_sessions (id, token_hash, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(input.id, input.tokenHash, input.createdAt, input.expiresAt)
    .run();
}

export async function getActiveAdminSession(
  database: D1Database,
  tokenHash: string,
  now: number,
): Promise<{ readonly id: string; readonly expires_at: number } | null> {
  return database
    .prepare(
      `SELECT id, expires_at
       FROM admin_sessions
       WHERE token_hash = ?1
         AND revoked_at IS NULL
         AND expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<{ id: string; expires_at: number }>();
}

export async function revokeAdminSession(
  database: D1Database,
  tokenHash: string,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `UPDATE admin_sessions
       SET revoked_at = COALESCE(revoked_at, ?1)
       WHERE token_hash = ?2 AND revoked_at IS NULL`,
    )
    .bind(now, tokenHash)
    .run();
}

export async function revokeAllAdminSessions(database: D1Database, now: number): Promise<void> {
  await database
    .prepare(
      `UPDATE admin_sessions
       SET revoked_at = ?1
       WHERE revoked_at IS NULL`,
    )
    .bind(now)
    .run();
}

export async function purgeExpiredAdminSessions(
  database: D1Database,
  now: number,
): Promise<number> {
  const result = await database
    .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?1 OR revoked_at IS NOT NULL")
    .bind(now)
    .run();
  return typeof result.meta.changes === "number" ? result.meta.changes : 0;
}
