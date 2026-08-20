import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { getConfig } from "../env";
import { getAccessibleFile } from "../repositories/file-repository";
import { deleteFileWithToken } from "../services/deletion-service";
import { toPublicFile } from "../services/file-service";
import { isFileId } from "../utils/hash";

export const fileRoutes = new Hono<AppEnv>();

fileRoutes.get("/files/:fileId", async (context) => {
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

fileRoutes.delete("/files/:fileId", async (context) => {
  const authorization = context.req.header("Authorization");
  const match = /^DeleteToken\s+(.+)$/u.exec(authorization ?? "");
  if (!match?.[1]) {
    throw new DomainError("INVALID_DELETE_TOKEN", 403, "缺少刪除憑證。");
  }

  const fileId = context.req.param("fileId");
  if (!isFileId(fileId)) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  await deleteFileWithToken(context.env, fileId, match[1], Math.floor(Date.now() / 1000));
  console.log(
    JSON.stringify({
      level: "info",
      event: "file.deleted",
      requestId: context.get("requestId"),
      fileId,
    }),
  );
  return context.body(null, 204);
});
