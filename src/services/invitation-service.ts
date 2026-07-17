import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";
import type { InvitationSession, UploadInvitation } from "../domain/invitation";
import {
  createSession,
  getInvitationByTokenHash,
  getSessionByTokenHash,
  revokeSessionByTokenHash,
} from "../repositories/invitation-repository";
import { hashPepperedValue, randomToken } from "../utils/hash";

const SESSION_COOKIE = "jwander_upload_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function invitationTokenHash(pepper: string, token: string): Promise<string> {
  return hashPepperedValue(pepper, `invitation\u0000${token}`);
}

function sessionTokenHash(pepper: string, token: string): Promise<string> {
  return hashPepperedValue(pepper, `upload-session\u0000${token}`);
}

function validateTokenShape(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new DomainError("INVITATION_INVALID", 403, "邀請連結無效或已過期。");
  }
}

export async function exchangeInvitationToken(
  context: Context<AppEnv>,
  token: string,
): Promise<{ invitation: UploadInvitation; sessionExpiresAt: number }> {
  validateTokenShape(token);
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await invitationTokenHash(context.env.DELETE_TOKEN_PEPPER, token);
  const invitation = await getInvitationByTokenHash(context.env.DB, tokenHash, now);
  if (invitation === null) {
    throw new DomainError("INVITATION_INVALID", 403, "邀請連結無效或已過期。");
  }

  const sessionToken = randomToken(32);
  const sessionExpiresAt = Math.min(invitation.expires_at, now + SESSION_TTL_SECONDS);
  await createSession(context.env.DB, {
    id: randomToken(16),
    tokenHash: await sessionTokenHash(context.env.DELETE_TOKEN_PEPPER, sessionToken),
    invitationId: invitation.id,
    createdAt: now,
    expiresAt: sessionExpiresAt,
  });

  setCookie(context, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/api/",
    maxAge: sessionExpiresAt - now,
  });
  return { invitation, sessionExpiresAt };
}

export async function resolveInvitationSession(
  context: Context<AppEnv>,
): Promise<InvitationSession | null> {
  const token = getCookie(context, SESSION_COOKIE);
  if (token === undefined) {
    return null;
  }
  const tokenHash = await sessionTokenHash(context.env.DELETE_TOKEN_PEPPER, token);
  return getSessionByTokenHash(context.env.DB, tokenHash, Math.floor(Date.now() / 1000));
}

export async function revokeCurrentInvitationSession(context: Context<AppEnv>): Promise<void> {
  const token = getCookie(context, SESSION_COOKIE);
  if (token !== undefined) {
    const tokenHash = await sessionTokenHash(context.env.DELETE_TOKEN_PEPPER, token);
    await revokeSessionByTokenHash(context.env.DB, tokenHash, Math.floor(Date.now() / 1000));
  }
  deleteCookie(context, SESSION_COOKIE, { path: "/api/", secure: true });
}

export function createInvitationTokenHash(pepper: string, token: string): Promise<string> {
  return invitationTokenHash(pepper, token);
}
