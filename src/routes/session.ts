import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { resolveAdminSession } from "../services/admin-session-service";

export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.get("/session/capabilities", async (context) => {
  context.header("Cache-Control", "private, no-store");
  return context.json({ admin: await resolveAdminSession(context) });
});
