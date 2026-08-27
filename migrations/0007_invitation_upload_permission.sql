ALTER TABLE upload_invitations
ADD COLUMN can_upload INTEGER NOT NULL DEFAULT 1
CHECK (can_upload IN (0, 1));
