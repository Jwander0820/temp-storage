import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";

const RETRY_AFTER_SECONDS = 60;

export const fileBrowserRateLimitMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const { success } = await context.env.FILE_BROWSER_RATE_LIMITER.limit({
    key: context.get("uploadSessionId"),
  });
  if (!success) {
    context.header("Retry-After", String(RETRY_AFTER_SECONDS));
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "file_browser.rate_limited",
        requestId: context.get("requestId"),
      }),
    );
    throw new DomainError("RATE_LIMITED", 429, "讀取頻率過高，請稍後再試。");
  }
  await next();
});
