CREATE INDEX idx_files_status_expires
ON files(status, expires_at);

CREATE INDEX idx_files_created_at
ON files(created_at);

CREATE INDEX idx_files_uploader_hash_created
ON files(uploader_hash, created_at);

CREATE INDEX idx_reservations_status_expires
ON upload_reservations(status, expires_at);

CREATE INDEX idx_rate_limit_uploader_created
ON rate_limit_events(uploader_hash, created_at);
