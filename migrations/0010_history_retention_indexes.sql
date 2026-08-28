CREATE INDEX IF NOT EXISTS idx_cleanup_runs_finished_at_id
ON cleanup_runs(finished_at, id);

CREATE INDEX IF NOT EXISTS idx_upload_invitations_history
ON upload_invitations(status, revoked_at, expires_at, id);

CREATE INDEX IF NOT EXISTS idx_files_invitation_id
ON files(invitation_id);

CREATE INDEX IF NOT EXISTS idx_upload_reservations_invitation_id
ON upload_reservations(invitation_id);

CREATE INDEX IF NOT EXISTS idx_files_terminal_history
ON files(status, created_at, id);
