import { Hono } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import { uploadSessionMiddleware } from "../middleware/upload-session";
import { getInvitationSummary } from "../repositories/invitation-repository";
import {
  exchangeInvitationToken,
  resolveInvitationSession,
  revokeCurrentInvitationSession,
} from "../services/invitation-service";
import { verifyOptionalAccessCode, verifyTurnstile } from "../services/turnstile-service";

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
    readonly max_bytes: number;
    readonly used_files: number;
    readonly used_bytes: number;
    readonly expires_at: number;
  },
  sessionExpiresAt: number,
) {
  return {
    authenticated: true,
    label: invitation.label,
    maxFiles: invitation.max_files,
    maxBytes: invitation.max_bytes,
    usedFiles: invitation.used_files,
    usedBytes: invitation.used_bytes,
    remainingFiles: Math.max(0, invitation.max_files - invitation.used_files),
    remainingBytes: Math.max(0, invitation.max_bytes - invitation.used_bytes),
    expiresAt: new Date(invitation.expires_at * 1000).toISOString(),
    sessionExpiresAt: new Date(sessionExpiresAt * 1000).toISOString(),
  };
}

export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.post("/invitations/exchange", async (context) => {
  context.header("Cache-Control", "private, no-store");
  const input = parseExchangeInput(await context.req.json<unknown>());
  await verifyOptionalAccessCode(context.env, input.accessCode);
  await verifyTurnstile(
    context.env,
    input.turnstileToken,
    context.req.header("CF-Connecting-IP") ?? "local-development",
    context.get("requestId"),
  );

  const { invitation, sessionExpiresAt } = await exchangeInvitationToken(context, input.token);
  const summary = await getInvitationSummary(context.env.DB, invitation.id);
  if (summary === null) {
    throw new DomainError("INTERNAL_ERROR", 500, "無法讀取邀請資料。");
  }
  return context.json(invitationPayload(summary, sessionExpiresAt));
});

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
