import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { timingSafeStringEqual } from "../utils/hash";

export const adminAuthMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const authorization = context.req.header("Authorization");
  const match = /^Bearer\s+(.+)$/u.exec(authorization ?? "");
  if (!match?.[1] || !(await timingSafeStringEqual(match[1], context.env.ADMIN_TOKEN))) {
    throw new DomainError("INVALID_REQUEST", 401, "管理員驗證失敗。");
  }
  await next();
});
