import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app-types";
import { getConfig } from "../env";
import {
  createAdminSession,
  getActiveAdminSession,
  revokeAdminSession,
  revokeAllAdminSessions as revokeAllAdminSessionsInRepository,
} from "../repositories/admin-session-repository";
import { hashPepperedValue, isRandomToken32, randomToken } from "../utils/hash";

export const ADMIN_SESSION_COOKIE = "jwander_admin_session";

function adminSessionTokenHash(pepper: string, token: string): Promise<string> {
  return hashPepperedValue(pepper, `admin-session\u0000${token}`);
}

export async function issueAdminSession(context: Context<AppEnv>): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const token = randomToken(32);
  const expiresAt = now + getConfig(context.env).adminSessionTtlSeconds;
  await createAdminSession(context.env.DB, {
    id: randomToken(16),
    tokenHash: await adminSessionTokenHash(context.env.DELETE_TOKEN_PEPPER, token),
    createdAt: now,
    expiresAt,
  });
  setCookie(context, ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/api",
    maxAge: expiresAt - now,
  });
  return expiresAt;
}

export async function resolveAdminSession(context: Context<AppEnv>): Promise<boolean> {
  const token = getCookie(context, ADMIN_SESSION_COOKIE);
  if (token === undefined || !isRandomToken32(token)) {
    return false;
  }
  const tokenHash = await adminSessionTokenHash(context.env.DELETE_TOKEN_PEPPER, token);
  return (
    (await getActiveAdminSession(context.env.DB, tokenHash, Math.floor(Date.now() / 1000))) !== null
  );
}

export async function revokeCurrentAdminSession(context: Context<AppEnv>): Promise<void> {
  const token = getCookie(context, ADMIN_SESSION_COOKIE);
  if (token !== undefined && isRandomToken32(token)) {
    const tokenHash = await adminSessionTokenHash(context.env.DELETE_TOKEN_PEPPER, token);
    await revokeAdminSession(context.env.DB, tokenHash, Math.floor(Date.now() / 1000));
  }
  deleteCookie(context, ADMIN_SESSION_COOKIE, { path: "/api", secure: true });
}

export async function revokeAllAdminSessions(context: Context<AppEnv>): Promise<void> {
  await revokeAllAdminSessionsInRepository(context.env.DB, Math.floor(Date.now() / 1000));
  deleteCookie(context, ADMIN_SESSION_COOKIE, { path: "/api", secure: true });
}
