import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";

export const requestIdMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
  context.set("requestId", requestId);
  context.header("X-Request-Id", requestId);
  await next();
});
