export type PreviewPolicy = "inline" | "download_only" | "blocked";

export type FileStatus =
  "reserved" | "uploading" | "active" | "deleting" | "deleted" | "rejected" | "failed";

export interface FileRecord {
  readonly id: string;
  readonly object_key: string;
  readonly original_name: string;
  readonly extension: string | null;
  readonly declared_mime: string | null;
  readonly detected_mime: string | null;
  readonly size_bytes: number;
  readonly preview_policy: PreviewPolicy | null;
  readonly status: FileStatus;
  readonly created_at: number;
  readonly expires_at: number;
  readonly deleted_at: number | null;
  readonly delete_token_hash: string | null;
  readonly uploader_hash: string | null;
  readonly sha256: string | null;
  readonly invitation_id: string | null;
}

export interface PublicFile {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly previewPolicy: Exclude<PreviewPolicy, "blocked">;
  readonly previewUrl: string | null;
  readonly downloadUrl: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}
