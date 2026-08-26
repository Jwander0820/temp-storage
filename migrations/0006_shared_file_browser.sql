CREATE INDEX idx_files_browse_active
ON files(status, created_at DESC, id DESC);
