import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import {
  invitationExchangeRateLimitMiddleware,
  jsonBodyLimitMiddleware,
} from "../middleware/request-protection";
import { uploadSessionMiddleware } from "../middleware/upload-session";
import { getInvitationSummary } from "../repositories/invitation-repository";
import {
  createInvitationSession,
  resolveInvitationToken,
  resolveInvitationSession,
  revokeCurrentInvitationSession,
} from "../services/invitation-service";
import { verifyOptionalAccessCode, verifyTurnstile } from "../services/turnstile-service";
import { readJsonBody } from "../utils/request";

interface ExchangeInvitationInput {
  readonly token: string;
  readonly turnstileToken: string;
  readonly accessCode: string | null;
}

function parseExchangeInput(value: unknown): ExchangeInvitationInput {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("INVALID_REQUEST", 400, "邀請資料格式不正確。");
  }
  const record = value as Record<string, unknown>;
  const token = record.token;
  const turnstileToken = record.turnstileToken;
  const accessCode = record.accessCode;
  if (
    typeof token !== "string" ||
    typeof turnstileToken !== "string" ||
    (accessCode !== undefined && accessCode !== null && typeof accessCode !== "string")
  ) {
    throw new DomainError("INVALID_REQUEST", 400, "邀請資料格式不正確。");
  }
  return {
    token,
    turnstileToken,
    accessCode: accessCode ?? null,
  };
}

function invitationPayload(
  invitation: {
    readonly label: string;
    readonly max_files: number;
    readonly unlimited_files: 0 | 1;
    readonly max_bytes: number;
    readonly can_upload: 0 | 1;
    readonly used_files: number;
    readonly used_bytes: number;
    readonly expires_at: number;
  },
  sessionExpiresAt: number,
) {
  return {
    authenticated: true,
    label: invitation.label,
    canUpload: invitation.can_upload === 1,
    maxFiles: invitation.can_upload === 1 ? invitation.max_files : 0,
    unlimitedFiles: invitation.can_upload === 1 && invitation.unlimited_files === 1,
    maxBytes: invitation.can_upload === 1 ? invitation.max_bytes : 0,
    usedFiles: invitation.used_files,
    usedBytes: invitation.used_bytes,
    remainingFiles:
      invitation.can_upload !== 1
        ? 0
        : invitation.unlimited_files === 1
          ? null
          : Math.max(0, invitation.max_files - invitation.used_files),
    remainingBytes:
      invitation.can_upload === 1 ? Math.max(0, invitation.max_bytes - invitation.used_bytes) : 0,
    expiresAt: new Date(invitation.expires_at * 1000).toISOString(),
    sessionExpiresAt: new Date(sessionExpiresAt * 1000).toISOString(),
  };
}

export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.post(
  "/invitations/exchange",
  invitationExchangeRateLimitMiddleware,
  jsonBodyLimitMiddleware,
  async (context) => {
    context.header("Cache-Control", "private, no-store");
    const input = parseExchangeInput(await readJsonBody(context));
    await verifyTurnstile(
      context.env,
      input.turnstileToken,
      context.req.header("CF-Connecting-IP") ?? "local-development",
      context.get("requestId"),
      "invite",
    );

    const invitation = await resolveInvitationToken(context, input.token);
    await verifyOptionalAccessCode(context.env, input.accessCode);
    const sessionExpiresAt = await createInvitationSession(context, invitation);
    const summary = await getInvitationSummary(context.env.DB, invitation.id);
    if (summary === null) {
      throw new DomainError("INTERNAL_ERROR", 500, "無法讀取邀請資料。");
    }
    return context.json(invitationPayload(summary, sessionExpiresAt));
  },
);

invitationRoutes.get("/invitations/session", uploadSessionMiddleware, async (context) => {
  context.header("Cache-Control", "private, no-store");
  const session = await resolveInvitationSession(context);
  if (session === null) {
    throw new DomainError("INVITATION_REQUIRED", 401, "邀請 session 已失效。");
  }
  return context.json(invitationPayload(session, session.session_expires_at));
});

invitationRoutes.delete("/invitations/session", async (context) => {
  await revokeCurrentInvitationSession(context);
  return context.body(null, 204);
});
