import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { resolveAdminSession } from "../services/admin-session-service";
import { timingSafeStringEqual } from "../utils/hash";

export const adminAuthMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const authorization = context.req.header("Authorization");
  const match = /^Bearer\s+(.+)$/u.exec(authorization ?? "");
  const bearerValid =
    match?.[1] !== undefined && (await timingSafeStringEqual(match[1], context.env.ADMIN_TOKEN));
  if (!bearerValid && !(await resolveAdminSession(context))) {
    throw new DomainError("INVALID_REQUEST", 401, "管理員驗證失敗。");
  }
  await next();
});
