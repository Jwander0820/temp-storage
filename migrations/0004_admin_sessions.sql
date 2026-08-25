CREATE TABLE admin_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_admin_sessions_expiry
ON admin_sessions(expires_at, revoked_at);
