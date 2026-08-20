import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { getConfig } from "../env";
import { getAccessibleFile } from "../repositories/file-repository";
import { serveStoredFile } from "../services/r2-service";
import { isFileId } from "../utils/hash";

export const mediaRoutes = new Hono<AppEnv>();

async function serve(context: Context<AppEnv>, mode: "preview" | "download"): Promise<Response> {
  const fileId = context.req.param("fileId");
  if (fileId === undefined || !isFileId(fileId)) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  const file = await getAccessibleFile(context.env.DB, fileId, Math.floor(Date.now() / 1000));
  if (file === null) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  if (mode === "preview" && file.preview_policy !== "inline") {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: mode === "preview" ? "file.previewed" : "file.downloaded",
      requestId: context.get("requestId"),
      fileId,
    }),
  );
  return serveStoredFile(
    context.req.raw,
    context.env.FILES,
    file,
    mode,
    getConfig(context.env).mediaPreviewCacheSeconds,
  );
}

mediaRoutes.on(["GET", "HEAD"], "/p/:fileId", (context) => serve(context, "preview"));
mediaRoutes.on(["GET", "HEAD"], "/d/:fileId", (context) => serve(context, "download"));
