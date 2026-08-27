import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { resolveAdminSession } from "../services/admin-session-service";

export const adminAuthMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  if (!(await resolveAdminSession(context))) {
    throw new DomainError("INVALID_REQUEST", 401, "管理員驗證失敗。");
  }
  await next();
});
