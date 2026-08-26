import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { resolveInvitationSession } from "../services/invitation-service";

export const uploadSessionMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const session = await resolveInvitationSession(context);
  if (session === null) {
    throw new DomainError("INVITATION_REQUIRED", 401, "請使用有效的邀請連結進入上傳頁面。");
  }
  context.set("uploadInvitationId", session.id);
  context.set("uploadSessionId", session.session_id);
  await next();
});
