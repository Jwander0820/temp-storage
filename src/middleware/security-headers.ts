import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { getConfig } from "../env";

function reportOnlyPolicy(cdnOrigin: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "font-src 'self'",
    `img-src 'self' data: ${cdnOrigin}`,
    `media-src 'self' blob: ${cdnOrigin}`,
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'none'",
  ].join("; ");
}

export const securityHeadersMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  await next();
  context.header(
    "Content-Security-Policy-Report-Only",
    reportOnlyPolicy(getConfig(context.env).cdnOrigin),
  );
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});
