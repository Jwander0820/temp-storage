import type { AppConfig } from "../env";
import type { FileRecord, PublicFile } from "../domain/file";

export function toPublicFile(file: FileRecord, config: AppConfig): PublicFile {
  if (
    file.status !== "active" ||
    file.detected_mime === null ||
    file.preview_policy === null ||
    file.preview_policy === "blocked"
  ) {
    throw new Error("Only active files can be serialized.");
  }

  return {
    id: file.id,
    filename: file.original_name,
    sizeBytes: file.size_bytes,
    detectedMime: file.detected_mime,
    previewPolicy: file.preview_policy,
    previewUrl: file.preview_policy === "inline" ? `${config.cdnOrigin}/p/${file.id}` : null,
    downloadUrl: `${config.uploadOrigin}/d/${file.id}`,
    createdAt: new Date(file.created_at * 1000).toISOString(),
    expiresAt: new Date(file.expires_at * 1000).toISOString(),
  };
}
