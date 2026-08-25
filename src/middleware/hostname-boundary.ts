import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { getConfig } from "../env";

function notFound(context: Context<AppEnv>) {
  context.header("Cache-Control", "private, no-store");
  return context.json(
    {
      error: {
        code: "FILE_NOT_FOUND",
        message: "找不到要求的資源。",
        requestId: context.get("requestId"),
      },
    },
    404,
  );
}

export const hostnameBoundaryMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const requestUrl = new URL(context.req.url);
  const config = getConfig(context.env);
  const uploadHostname = new URL(config.uploadOrigin).hostname;

  if (requestUrl.hostname === uploadHostname) {
    await next();
    return;
  }

  return notFound(context);
});
