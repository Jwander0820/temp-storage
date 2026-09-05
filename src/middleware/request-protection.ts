import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";

export const JSON_BODY_MAX_BYTES = 16 * 1024;
const RETRY_AFTER_SECONDS = 60;

export const jsonBodyLimitMiddleware = bodyLimit({
  maxSize: JSON_BODY_MAX_BYTES,
  onError: () => {
    throw new DomainError("REQUEST_BODY_TOO_LARGE", 413, "要求內容超過允許的大小上限。");
  },
});

function remoteIp(context: Context<AppEnv>): string {
  return context.req.header("CF-Connecting-IP") ?? "local-development";
}

function rejectRateLimited(context: Context<AppEnv>, event: string, message: string): never {
  context.header("Retry-After", String(RETRY_AFTER_SECONDS));
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      requestId: context.get("requestId"),
    }),
  );
  throw new DomainError("RATE_LIMITED", 429, message);
}

export const invitationExchangeRateLimitMiddleware = createMiddleware<AppEnv>(
  async (context, next) => {
    const { success } = await context.env.INVITATION_EXCHANGE_RATE_LIMITER.limit({
      key: remoteIp(context),
    });
    if (!success) {
      rejectRateLimited(
        context,
        "invitation_exchange.rate_limited",
        "邀請驗證要求過於頻繁，請稍後再試。",
      );
    }
    await next();
  },
);

export const publicFileRateLimitMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const { success } = await context.env.PUBLIC_FILE_RATE_LIMITER.limit({
    key: remoteIp(context),
  });
  if (!success) {
    rejectRateLimited(context, "public_file.rate_limited", "檔案讀取要求過於頻繁，請稍後再試。");
  }
  await next();
});

export const deleteMutationRateLimitMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const { success } = await context.env.DELETE_MUTATION_RATE_LIMITER.limit({
    key: remoteIp(context),
  });
  if (!success) {
    rejectRateLimited(context, "delete_mutation.rate_limited", "刪除要求過於頻繁，請稍後再試。");
  }
  await next();
});

export const uploadMutationRateLimitMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const { success } = await context.env.UPLOAD_MUTATION_RATE_LIMITER.limit({
    key: remoteIp(context),
  });
  if (!success) {
    rejectRateLimited(context, "upload_mutation.rate_limited", "上傳要求過於頻繁，請稍後再試。");
  }
  await next();
});
