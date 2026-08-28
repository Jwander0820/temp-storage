import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { getConfig } from "../env";
import { ADMIN_SESSION_COOKIE } from "../services/admin-session-service";
import { INVITATION_SESSION_COOKIE } from "../services/invitation-service";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const sameOriginSessionMutationMiddleware = createMiddleware<AppEnv>(
  async (context, next) => {
    const hasSessionCookie =
      getCookie(context, ADMIN_SESSION_COOKIE) !== undefined ||
      getCookie(context, INVITATION_SESSION_COOKIE) !== undefined;
    if (!MUTATION_METHODS.has(context.req.method) || !hasSessionCookie) {
      await next();
      return;
    }

    if (context.req.header("Origin") !== getConfig(context.env).uploadOrigin) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "request.origin_rejected",
          requestId: context.get("requestId"),
        }),
      );
      throw new DomainError("INVALID_REQUEST", 403, "不允許從目前的來源執行這項操作。");
    }

    await next();
  },
);
