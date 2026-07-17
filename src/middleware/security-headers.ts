import { createMiddleware } from "hono/factory";

export const securityHeadersMiddleware = createMiddleware(async (context, next) => {
  await next();
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});
