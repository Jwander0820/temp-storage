import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidAdminToken } from "../src/env";
import {
  createTestAdminSession,
  createTestInvitationSession,
  mockSuccessfulTurnstile,
  resetState,
  TEST_ADMIN_TOKEN,
  TEST_UPLOAD_ORIGIN,
} from "./helpers";

let loginSequence = 0;

async function login(
  token = TEST_ADMIN_TOKEN,
  turnstileToken = "test-admin-challenge",
  ip = `203.0.113.${++loginSequence}`,
): Promise<Response> {
  return exports.default.fetch(
    new Request("https://upload.example.test/api/admin/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "CF-Connecting-IP": ip,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ turnstileToken }),
    }),
  );
}

function adminRequest(path: string, cookie: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://upload.example.test${path}`, {
      headers: { Cookie: cookie },
    }),
  );
}

describe("admin browser session", () => {
  beforeEach(async () => {
    await resetState();
    mockSuccessfulTurnstile("admin");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges the admin token for an HttpOnly session and manages invitations", async () => {
    const response = await login();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api");
    expect(setCookie).not.toContain(TEST_ADMIN_TOKEN);
    const cookie = setCookie.split(";", 1)[0] ?? setCookie;

    const session = await adminRequest("/api/admin/session", cookie);
    expect(session.status).toBe(200);
    expect(session.headers.get("Cache-Control")).toBe("private, no-store");

    const created = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/invitations", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: JSON.stringify({
          label: "手機建立",
          expiresInSeconds: 7 * 86_400,
          maxFiles: 10,
          unlimitedFiles: true,
          maxBytes: 300 * 1024 * 1024,
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("private, no-store");
    const createdPayload = await created.json<{
      id: string;
      label: string;
      maxFiles: number;
      unlimitedFiles: boolean;
    }>();
    expect(createdPayload).toMatchObject({
      label: "手機建立",
      maxFiles: 10,
      unlimitedFiles: true,
    });

    const listed = await adminRequest("/api/admin/invitations", cookie);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      invitations: [{ label: "手機建立", status: "active", usedFiles: 0 }],
    });

    const revoked = await exports.default.fetch(
      new Request(`https://upload.example.test/api/admin/invitations/${createdPayload.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: TEST_UPLOAD_ORIGIN },
      }),
    );
    expect(revoked.status).toBe(204);

    const logout = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/session", {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: TEST_UPLOAD_ORIGIN },
      }),
    );
    expect(logout.status).toBe(204);
    expect((await adminRequest("/api/admin/session", cookie)).status).toBe(401);
  });

  it("verifies Turnstile before rejecting an invalid admin token", async () => {
    const response = await login("wrong-admin-token");
    expect(response.status).toBe(401);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("returns the same neutral failure when Turnstile rejects the login", async () => {
    vi.mocked(globalThis.fetch).mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({ success: false, hostname: "upload.example.test", action: "admin" }),
      ),
    );
    const response = await login();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST", message: "管理員驗證失敗。" },
    });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS count FROM admin_sessions").first<{
      count: number;
    }>();
    expect(stored?.count).toBe(0);
  });

  it("rate limits admin login before calling Turnstile", async () => {
    vi.spyOn(env.ADMIN_LOGIN_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    const response = await login(TEST_ADMIN_TOKEN, "test-admin-challenge", "198.51.100.20");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not accept the permanent token on admin APIs", async () => {
    const response = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/status", {
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects expired and revoked sessions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await createTestAdminSession({
      token: "E".repeat(43),
      createdAt: now - 20,
      expiresAt: now - 10,
    });
    const revoked = await createTestAdminSession({ token: "R".repeat(43), revoked: true });
    expect((await adminRequest("/api/admin/status", expired)).status).toBe(401);
    expect((await adminRequest("/api/admin/status", revoked)).status).toBe(401);
  });

  it("revokes every admin session including the caller", async () => {
    const sessions = await Promise.all(
      ["A", "B", "C"].map((prefix) =>
        createTestAdminSession({ token: `${prefix}${"x".repeat(42)}` }),
      ),
    );
    const response = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/sessions/revoke-all", {
        method: "POST",
        headers: { Cookie: sessions[0] ?? "", Origin: TEST_UPLOAD_ORIGIN },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("jwander_admin_session=");
    for (const cookie of sessions) {
      expect((await adminRequest("/api/admin/status", cookie)).status).toBe(401);
    }
  });

  it("exposes only the public admin capability for each session state", async () => {
    const anonymous = await adminRequest("/api/session/capabilities", "");
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(anonymous.json()).resolves.toEqual({ admin: false });

    vi.restoreAllMocks();
    mockSuccessfulTurnstile("invite");
    const invitation = await createTestInvitationSession();
    await expect(
      (await adminRequest("/api/session/capabilities", invitation)).json(),
    ).resolves.toEqual({ admin: false });

    const admin = await createTestAdminSession({ token: "S".repeat(43) });
    await expect((await adminRequest("/api/session/capabilities", admin)).json()).resolves.toEqual({
      admin: true,
    });

    const now = Math.floor(Date.now() / 1000);
    const expired = await createTestAdminSession({
      token: "T".repeat(43),
      createdAt: now - 20,
      expiresAt: now - 10,
    });
    await expect(
      (await adminRequest("/api/session/capabilities", expired)).json(),
    ).resolves.toEqual({ admin: false });
  });

  it("requires a url-safe token with at least 32 bytes of random material", () => {
    expect(() => assertValidAdminToken("too-short")).toThrow("Invalid ADMIN_TOKEN configuration");
    expect(() => assertValidAdminToken(TEST_ADMIN_TOKEN)).not.toThrow();
  });
});
