import type { FileRecord, PublicFile } from "../domain/file";
import { DomainError } from "../domain/errors";
import type { AppConfig } from "../env";
import { isFileId } from "../utils/hash";
import { toPublicFile } from "./file-service";

export type BrowseFileType = "all" | "image" | "video" | "audio" | "other";

export interface BrowseFilesInput {
  readonly now: number;
  readonly cursor: string | null;
  readonly limit: number;
  readonly type: BrowseFileType;
}

export interface BrowseFilesResult {
  readonly files: PublicFile[];
  readonly nextCursor: string | null;
}

const BROWSE_TYPES = new Set<BrowseFileType>(["all", "image", "video", "audio", "other"]);

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string | null): {
  readonly createdAt: number | null;
  readonly id: string | null;
} {
  if (cursor === null) {
    return { createdAt: null, id: null };
  }
  if (cursor.length === 0 || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new DomainError("INVALID_REQUEST", 400, "游標格式不正確。");
  }

  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (
      separator <= 0 ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !isFileId(id) ||
      encodeCursor(createdAt, id) !== cursor
    ) {
      throw new Error("Invalid cursor");
    }
    return { createdAt, id };
  } catch {
    throw new DomainError("INVALID_REQUEST", 400, "游標格式不正確。");
  }
}

export async function browseActiveFiles(
  database: D1Database,
  config: AppConfig,
  input: BrowseFilesInput,
): Promise<BrowseFilesResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 60) {
    throw new DomainError("INVALID_REQUEST", 400, "limit 必須介於 1 與 60 之間。");
  }
  if (!BROWSE_TYPES.has(input.type)) {
    throw new DomainError("INVALID_REQUEST", 400, "檔案類型篩選不正確。");
  }

  const cursor = decodeCursor(input.cursor);
  const result = await database
    .prepare(
      `SELECT *
       FROM files INDEXED BY idx_files_browse_active
       WHERE status = 'active'
         AND expires_at > ?1
         AND (
           ?2 IS NULL
           OR created_at < ?2
           OR (created_at = ?2 AND id < ?3)
         )
         AND (
           ?4 = 'all'
           OR (?4 = 'image' AND detected_mime LIKE 'image/%')
           OR (?4 = 'video' AND detected_mime LIKE 'video/%')
           OR (?4 = 'audio' AND detected_mime LIKE 'audio/%')
           OR (
             ?4 = 'other'
             AND detected_mime NOT LIKE 'image/%'
             AND detected_mime NOT LIKE 'video/%'
             AND detected_mime NOT LIKE 'audio/%'
           )
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ?5`,
    )
    .bind(input.now, cursor.createdAt, cursor.id, input.type, input.limit + 1)
    .all<FileRecord>();

  const hasMore = result.results.length > input.limit;
  const page = hasMore ? result.results.slice(0, input.limit) : result.results;
  const last = page.at(-1);
  return {
    files: page.map((file) => toPublicFile(file, config)),
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
  };
}
