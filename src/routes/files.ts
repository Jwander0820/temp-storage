import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { getConfig } from "../env";
import { fileBrowserAccessMiddleware } from "../middleware/file-browser-access";
import { fileBrowserRateLimitMiddleware } from "../middleware/file-browser-rate-limit";
import {
  deleteMutationRateLimitMiddleware,
  publicFileRateLimitMiddleware,
} from "../middleware/request-protection";
import { getAccessibleFile } from "../repositories/file-repository";
import { deleteFileWithToken } from "../services/deletion-service";
import { browseActiveFiles, type BrowseFileType } from "../services/file-browser-service";
import { toPublicFile } from "../services/file-service";
import { isFileId, isRandomToken32 } from "../utils/hash";

export const fileRoutes = new Hono<AppEnv>();

fileRoutes.get(
  "/files",
  fileBrowserAccessMiddleware,
  fileBrowserRateLimitMiddleware,
  async (context) => {
    context.header("Cache-Control", "private, no-store");
    const limitValue = context.req.query("limit") ?? "24";
    if (!/^\d+$/u.test(limitValue)) {
      throw new DomainError("INVALID_REQUEST", 400, "limit 格式不正確。");
    }
    const type = (context.req.query("type") ?? "all") as BrowseFileType;
    const result = await browseActiveFiles(context.env.DB, getConfig(context.env), {
      now: Math.floor(Date.now() / 1000),
      cursor: context.req.query("cursor") ?? null,
      limit: Number(limitValue),
      type,
    });
    return context.json(result);
  },
);

fileRoutes.get("/files/:fileId", publicFileRateLimitMiddleware, async (context) => {
  const fileId = context.req.param("fileId");
  if (!isFileId(fileId)) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  const now = Math.floor(Date.now() / 1000);
  const file = await getAccessibleFile(context.env.DB, fileId, now);
  if (file === null) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  context.header("Cache-Control", "private, no-store");
  return context.json(toPublicFile(file, getConfig(context.env)));
});

async function deleteWithCapability(context: Context<AppEnv>) {
  const authorization = context.req.header("Authorization");
  const match = /^DeleteToken\s+(\S+)$/u.exec(authorization ?? "");
  const deleteToken = match?.[1];
  if (deleteToken === undefined || !isRandomToken32(deleteToken)) {
    throw new DomainError("INVALID_DELETE_TOKEN", 403, "缺少刪除憑證。");
  }

  const fileId = context.req.param("fileId");
  if (fileId === undefined || !isFileId(fileId)) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  await deleteFileWithToken(context.env, fileId, deleteToken, Math.floor(Date.now() / 1000));
  console.log(
    JSON.stringify({
      level: "info",
      event: "file.deleted",
      requestId: context.get("requestId"),
      fileId,
    }),
  );
  return context.body(null, 204);
}

fileRoutes.delete("/delete/:fileId", deleteMutationRateLimitMiddleware, deleteWithCapability);

// Backward compatibility for delete capabilities returned before the dedicated route existed.
fileRoutes.delete("/files/:fileId", deleteMutationRateLimitMiddleware, deleteWithCapability);
