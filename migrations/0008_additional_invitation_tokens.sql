PRAGMA foreign_keys = ON;

CREATE TABLE upload_invitation_tokens (
    token_hash TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(invitation_id) REFERENCES upload_invitations(id)
);

CREATE INDEX idx_upload_invitation_tokens_invitation
ON upload_invitation_tokens(invitation_id, created_at);
