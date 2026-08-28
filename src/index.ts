import { Hono } from "hono";
import type { AppEnv } from "./app-types";
import type { Bindings } from "./bindings";
import { assertValidAdminToken, getConfig } from "./env";
import { handleError } from "./middleware/error-handler";
import { hostnameBoundaryMiddleware } from "./middleware/hostname-boundary";
import { requestIdMiddleware } from "./middleware/request-id";
import { sameOriginSessionMutationMiddleware } from "./middleware/same-origin-mutation";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { adminRoutes } from "./routes/admin";
import { fileRoutes } from "./routes/files";
import { invitationRoutes } from "./routes/invitations";
import { mediaRoutes } from "./routes/media";
import { sessionRoutes } from "./routes/session";
import { storageRoutes } from "./routes/storage";
import { uploadRoutes } from "./routes/uploads";
import { reconcileStorage, runCleanup } from "./services/cleanup-service";

const app = new Hono<AppEnv>();

app.use("*", requestIdMiddleware);
app.use("*", async (context, next) => {
  assertValidAdminToken(context.env.ADMIN_TOKEN);
  await next();
});
app.use("*", securityHeadersMiddleware);
app.use("*", hostnameBoundaryMiddleware);
app.use("*", sameOriginSessionMutationMiddleware);

app.get("/api/health", (context) => {
  context.header(
    "Cache-Control",
    `public, max-age=${getConfig(context.env).publicConfigCacheSeconds}`,
  );
  return context.json({ status: "ok" });
});
app.route("/api", storageRoutes);
app.route("/api", invitationRoutes);
app.route("/api", uploadRoutes);
app.route("/api", fileRoutes);
app.route("/api", sessionRoutes);
app.route("/api/admin", adminRoutes);
app.route("/", mediaRoutes);

app.notFound((context) => {
  const url = new URL(context.req.url);
  const uploadHostname = new URL(context.env.UPLOAD_ORIGIN).hostname;
  if (
    url.hostname === uploadHostname &&
    (context.req.method === "GET" || context.req.method === "HEAD") &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/p/") &&
    !url.pathname.startsWith("/d/")
  ) {
    return context.env.ASSETS.fetch(context.req.raw);
  }
  context.header("Cache-Control", "private, no-store");
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
});

app.onError(handleError);

export default {
  fetch: app.fetch,
  scheduled(controller, env, context): void {
    assertValidAdminToken(env.ADMIN_TOKEN);
    context.waitUntil(
      (async () => {
        await runCleanup(env);
        const scheduledHour = new Date(controller.scheduledTime).getUTCHours();
        if (scheduledHour === 3) {
          await reconcileStorage(env);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Bindings>;
