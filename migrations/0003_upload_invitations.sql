PRAGMA foreign_keys = ON;

CREATE TABLE upload_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    max_files INTEGER NOT NULL,
    max_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    CHECK (length(label) BETWEEN 1 AND 80),
    CHECK (max_files > 0),
    CHECK (max_bytes > 0),
    CHECK (expires_at > created_at),
    CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    invitation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY(invitation_id) REFERENCES upload_invitations(id),
    CHECK (expires_at > created_at)
);

ALTER TABLE files
ADD COLUMN invitation_id TEXT REFERENCES upload_invitations(id);

ALTER TABLE upload_reservations
ADD COLUMN invitation_id TEXT REFERENCES upload_invitations(id);

ALTER TABLE rate_limit_events
ADD COLUMN invitation_id TEXT REFERENCES upload_invitations(id);

CREATE INDEX idx_upload_sessions_invitation
ON upload_sessions(invitation_id, expires_at);

CREATE INDEX idx_upload_invitations_status_expiry
ON upload_invitations(status, expires_at);

CREATE INDEX idx_rate_limit_events_invitation
ON rate_limit_events(invitation_id, created_at);
