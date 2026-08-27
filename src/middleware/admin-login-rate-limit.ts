import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";

const RETRY_AFTER_SECONDS = 60;

export const adminLoginRateLimitMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const { success } = await context.env.ADMIN_LOGIN_RATE_LIMITER.limit({
    key: context.req.header("CF-Connecting-IP") ?? "local-development",
  });
  if (!success) {
    context.header("Retry-After", String(RETRY_AFTER_SECONDS));
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "admin_login.rate_limited",
        timestamp: new Date().toISOString(),
        requestId: context.get("requestId"),
      }),
    );
    throw new DomainError("RATE_LIMITED", 429, "管理員驗證要求過於頻繁，請稍後再試。");
  }
  await next();
});
