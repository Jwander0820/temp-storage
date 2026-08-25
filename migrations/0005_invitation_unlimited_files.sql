ALTER TABLE upload_invitations
ADD COLUMN unlimited_files INTEGER NOT NULL DEFAULT 0
CHECK (unlimited_files IN (0, 1));
