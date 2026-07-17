import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { getConfig } from "../env";

const publicMediaPath = /^\/(?:p|d)\/[A-Za-z0-9_-]+$/u;

function notFound(context: Context<AppEnv>) {
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
  const cdnHostname = new URL(config.cdnOrigin).hostname;

  if (requestUrl.hostname === uploadHostname) {
    await next();
    return;
  }

  if (
    requestUrl.hostname === cdnHostname &&
    (context.req.method === "GET" || context.req.method === "HEAD") &&
    publicMediaPath.test(requestUrl.pathname)
  ) {
    await next();
    return;
  }

  return notFound(context);
});
