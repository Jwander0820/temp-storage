import type { FileRecord, PreviewPolicy } from "../domain/file";
import { DomainError } from "../domain/errors";
import { contentDisposition } from "../utils/filename";
import { parseRangeHeader, type ByteRange } from "../utils/range";

export async function storeObject(
  bucket: R2Bucket,
  file: FileRecord,
  body: ReadableStream,
  detectedMime: string,
  previewPolicy: Exclude<PreviewPolicy, "blocked">,
  previewCacheSeconds: number,
): Promise<R2Object> {
  const publiclyPreviewable = previewPolicy === "inline";
  const stored = await bucket.put(file.object_key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: detectedMime,
      contentDisposition: contentDisposition(
        publiclyPreviewable ? "inline" : "attachment",
        file.original_name,
      ),
      cacheControl:
        publiclyPreviewable && previewCacheSeconds > 0
          ? `public, max-age=${previewCacheSeconds}`
          : "private, no-store",
    },
    customMetadata: {
      fileId: file.id,
    },
    storageClass: "Standard",
  });

  if (stored === null) {
    throw new DomainError("UPLOAD_FAILED", 500, "檔案儲存鍵發生衝突，請重新上傳。");
  }
  return stored;
}

function createMediaHeaders(
  file: FileRecord,
  mode: "preview" | "download",
  range: ByteRange | null,
  etag: string | null,
  previewCacheSeconds: number,
): Headers {
  const totalBytes = file.size_bytes;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(
      mode === "preview" ? "inline" : "attachment",
      file.original_name,
    ),
    "Content-Length": String(range?.length ?? totalBytes),
    "Content-Type":
      mode === "preview" || file.preview_policy === "inline"
        ? (file.detected_mime ?? "application/octet-stream")
        : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });

  if (range !== null) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${totalBytes}`,
    );
  }
  if (etag !== null) {
    headers.set("ETag", etag);
  }

  if (mode === "preview") {
    headers.set(
      "Cache-Control",
      range === null && previewCacheSeconds > 0
        ? `public, max-age=${previewCacheSeconds}`
        : "private, no-store",
    );
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  } else {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Content-Security-Policy", "sandbox");
  }
  return headers;
}

export async function serveStoredFile(
  request: Request,
  bucket: R2Bucket,
  file: FileRecord,
  mode: "preview" | "download",
  previewCacheSeconds: number,
): Promise<Response> {
  const rangeHeader = request.headers.get("Range");
  let range: ByteRange | null = null;
  if (rangeHeader !== null) {
    try {
      range = parseRangeHeader(rangeHeader, file.size_bytes);
    } catch (error) {
      if (error instanceof DomainError && error.code === "INVALID_RANGE") {
        return new Response(null, {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
            "Content-Range": `bytes */${file.size_bytes}`,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      throw error;
    }
  }

  if (request.method === "HEAD") {
    const object = await bucket.head(file.object_key);
    if (object === null) {
      throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
    }
    return new Response(null, {
      status: range === null ? 200 : 206,
      headers: createMediaHeaders(file, mode, range, object.httpEtag, previewCacheSeconds),
    });
  }

  const object =
    range === null
      ? await bucket.get(file.object_key)
      : await bucket.get(file.object_key, {
          range: { offset: range.offset, length: range.length },
        });

  if (object === null) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }

  return new Response(object.body, {
    status: range === null ? 200 : 206,
    headers: createMediaHeaders(file, mode, range, object.httpEtag, previewCacheSeconds),
  });
}
