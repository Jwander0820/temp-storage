import { Hono } from "hono";
import type { AppEnv } from "./app-types";
import type { Bindings } from "./bindings";
import { handleError } from "./middleware/error-handler";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { adminRoutes } from "./routes/admin";
import { fileRoutes } from "./routes/files";
import { mediaRoutes } from "./routes/media";
import { storageRoutes } from "./routes/storage";
import { uploadRoutes } from "./routes/uploads";
import { reconcileStorage, runCleanup } from "./services/cleanup-service";

const app = new Hono<AppEnv>();

app.use("*", requestIdMiddleware);
app.use("*", securityHeadersMiddleware);

app.get("/api/health", (context) => context.json({ status: "ok" }));
app.route("/api", storageRoutes);
app.route("/api", uploadRoutes);
app.route("/api", fileRoutes);
app.route("/api/admin", adminRoutes);
app.route("/", mediaRoutes);

app.notFound((context) =>
  context.json(
    {
      error: {
        code: "FILE_NOT_FOUND",
        message: "找不到要求的資源。",
        requestId: context.get("requestId"),
      },
    },
    404,
  ),
);

app.onError(handleError);

export default {
  fetch: app.fetch,
  scheduled(controller, env, context): void {
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
