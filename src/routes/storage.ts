import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { getConfig } from "../env";
import { getPublicStorageUsage } from "../services/quota-service";

export const storageRoutes = new Hono<AppEnv>();

storageRoutes.get("/storage", async (context) => {
  return context.json(await getPublicStorageUsage(context.env.DB));
});

storageRoutes.get("/config", (context) => {
  const config = getConfig(context.env);
  return context.json({
    maxFileBytes: config.maxFileBytes,
    fileRetentionSeconds: config.fileRetentionSeconds,
    uploadsEnabled: config.uploadsEnabled,
    turnstileSiteKey: config.turnstileSiteKey,
    accessCodeRequired: Boolean(context.env.UPLOAD_ACCESS_CODE?.trim()),
  });
});
