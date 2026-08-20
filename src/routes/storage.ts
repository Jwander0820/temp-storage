import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { getConfig } from "../env";
import { uploadSessionMiddleware } from "../middleware/upload-session";
import { getPublicStorageUsage } from "../services/quota-service";

export const storageRoutes = new Hono<AppEnv>();

storageRoutes.use("/storage", uploadSessionMiddleware);

storageRoutes.get("/storage", async (context) => {
  context.header("Cache-Control", "private, no-store");
  return context.json(await getPublicStorageUsage(context.env.DB));
});

storageRoutes.get("/config", (context) => {
  const config = getConfig(context.env);
  context.header("Cache-Control", `public, max-age=${config.publicConfigCacheSeconds}`);
  return context.json({
    maxFileBytes: config.maxFileBytes,
    fileRetentionSeconds: config.fileRetentionSeconds,
    uploadsEnabled: config.uploadsEnabled,
    turnstileSiteKey: config.turnstileSiteKey,
    accessCodeRequired: Boolean(context.env.UPLOAD_ACCESS_CODE?.trim()),
    maxFilesPerBatch: config.clientMaxFilesPerBatch,
    maxParallelUploads: config.clientMaxParallelUploads,
    sessionTtlSeconds: config.uploadSessionTtlSeconds,
  });
});
