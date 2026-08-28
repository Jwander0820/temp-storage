CREATE INDEX IF NOT EXISTS idx_files_status_deleted_at_id
ON files(status, deleted_at, id);
