CREATE TABLE private_partitions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  max_files INTEGER NOT NULL CHECK (max_files > 0),
  unlimited_files INTEGER NOT NULL DEFAULT 0 CHECK (unlimited_files IN (0, 1)),
  max_bytes INTEGER NOT NULL CHECK (max_bytes > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER
);

ALTER TABLE upload_invitations ADD COLUMN partition_id TEXT REFERENCES private_partitions(id);
ALTER TABLE files ADD COLUMN partition_id TEXT REFERENCES private_partitions(id);
CREATE INDEX idx_invitations_partition ON upload_invitations(partition_id);
CREATE INDEX idx_files_partition ON files(partition_id, status, created_at DESC, id DESC);
CREATE INDEX idx_partitions_expiry ON private_partitions(status, expires_at);

-- A credential identifies an uploader; its partition owns the shared policy.
CREATE VIEW effective_invitations AS
SELECT i.id, i.token_hash, i.label,
  CASE WHEN p.status = 'revoked' THEN 'revoked' ELSE i.status END AS status,
  COALESCE(p.max_files, i.max_files) AS max_files,
  COALESCE(p.unlimited_files, i.unlimited_files) AS unlimited_files,
  COALESCE(p.max_bytes, i.max_bytes) AS max_bytes,
  i.can_upload, i.created_at,
  COALESCE(p.expires_at, i.expires_at) AS expires_at,
  COALESCE(i.revoked_at, p.revoked_at) AS revoked_at,
  i.partition_id, p.label AS partition_label
FROM upload_invitations i LEFT JOIN private_partitions p ON p.id = i.partition_id;

-- Keep the original file retention deadline, so extending a partition never
-- extends a file beyond its own retention limit.
CREATE VIEW effective_files AS
SELECT f.id, f.object_key, f.original_name, f.extension, f.declared_mime,
  f.detected_mime, f.size_bytes, f.preview_policy, f.status, f.created_at,
  CASE WHEN p.status = 'revoked' THEN MIN(f.expires_at, p.revoked_at)
       ELSE MIN(f.expires_at, COALESCE(p.expires_at, f.expires_at)) END AS expires_at,
  f.deleted_at, f.delete_token_hash, f.uploader_hash, f.sha256, f.invitation_id,
  f.partition_id, p.label AS partition_label, i.label AS uploader_label
FROM files f
LEFT JOIN private_partitions p ON p.id = f.partition_id
LEFT JOIN upload_invitations i ON i.id = f.invitation_id;
