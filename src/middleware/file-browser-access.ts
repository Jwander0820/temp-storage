import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { resolveAdminSession } from "../services/admin-session-service";
import { resolveInvitationSession } from "../services/invitation-service";

export const fileBrowserAccessMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  if (await resolveAdminSession(context)) {
    context.set("fileBrowserPrincipalId", "admin");
    await next();
    return;
  }

  const session = await resolveInvitationSession(context);
  if (session === null) {
    throw new DomainError("INVITATION_REQUIRED", 401, "請使用有效的邀請連結進入上傳頁面。");
  }

  context.set("uploadInvitationId", session.id);
  context.set("uploadSessionId", session.session_id);
  context.set("fileBrowserPrincipalId", session.session_id);
  await next();
});
