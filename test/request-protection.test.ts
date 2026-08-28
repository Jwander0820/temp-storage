import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSON_BODY_MAX_BYTES } from "../src/middleware/request-protection";
import {
  createTestAdminSession,
  createTestInvitationSession,
  mockSuccessfulTurnstile,
  resetState,
  TEST_ADMIN_TOKEN,
  TEST_UPLOAD_ORIGIN,
} from "./helpers";

function oversizedJson(): string {
  return JSON.stringify({ padding: "x".repeat(JSON_BODY_MAX_BYTES) });
}

describe("public request protections", () => {
  beforeEach(async () => {
    await resetState();
    mockSuccessfulTurnstile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects oversized JSON bodies on every JSON mutation route", async () => {
    vi.spyOn(env.INVITATION_EXCHANGE_RATE_LIMITER, "limit").mockResolvedValue({ success: true });
    vi.spyOn(env.ADMIN_LOGIN_RATE_LIMITER, "limit").mockResolvedValue({ success: true });
    const [adminCookie, invitationCookie] = await Promise.all([
      createTestAdminSession(),
      createTestInvitationSession(),
    ]);
    const body = oversizedJson();
    const requests = [
      new Request("https://upload.example.test/api/invitations/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      new Request("https://upload.example.test/api/admin/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body,
      }),
      new Request("https://upload.example.test/api/admin/invitations", {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body,
      }),
      new Request("https://upload.example.test/api/uploads/reserve", {
        method: "POST",
        headers: {
          Cookie: invitationCookie,
          "Content-Type": "application/json",
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body,
      }),
    ];

    for (const request of requests) {
      const response = await exports.default.fetch(request);
      expect(response.status, new URL(request.url).pathname).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "REQUEST_BODY_TOO_LARGE" },
      });
    }
  });

  it("returns a client error for malformed invitation JSON without calling Turnstile", async () => {
    vi.spyOn(env.INVITATION_EXCHANGE_RATE_LIMITER, "limit").mockResolvedValue({ success: true });
    const response = await exports.default.fetch(
      new Request("https://upload.example.test/api/invitations/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rate limits invitation exchange before parsing or Turnstile verification", async () => {
    vi.spyOn(env.INVITATION_EXCHANGE_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    const response = await exports.default.fetch(
      new Request("https://upload.example.test/api/invitations/exchange", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "198.51.100.40",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rate limits public file capabilities before D1 and R2 work", async () => {
    vi.spyOn(env.PUBLIC_FILE_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    const fileId = "A".repeat(22);
    const requests = [
      new Request(`https://upload.example.test/api/files/${fileId}`),
      new Request(`https://upload.example.test/api/files/${fileId}`, { method: "DELETE" }),
      new Request(`https://upload.example.test/p/${fileId}`),
      new Request(`https://upload.example.test/d/${fileId}`, { method: "HEAD" }),
    ];

    for (const request of requests) {
      const response = await exports.default.fetch(request);
      expect(response.status, `${request.method} ${new URL(request.url).pathname}`).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    }
  });
});

describe("same-origin session mutation protection", () => {
  beforeEach(async () => {
    await resetState();
    mockSuccessfulTurnstile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing, null, and sibling origins without revoking the admin session", async () => {
    const cookie = await createTestAdminSession();
    for (const origin of [undefined, "null", "https://cdn.example.test"]) {
      const headers = new Headers({ Cookie: cookie });
      if (origin !== undefined) {
        headers.set("Origin", origin);
      }
      const response = await exports.default.fetch(
        new Request("https://upload.example.test/api/admin/sessions/revoke-all", {
          method: "POST",
          headers,
        }),
      );
      expect(response.status, origin ?? "missing Origin").toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
    }

    const session = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/session", {
        headers: { Cookie: cookie },
      }),
    );
    expect(session.status).toBe(200);
  });

  it("rejects a sibling origin before an admin reconciliation reaches R2", async () => {
    const cookie = await createTestAdminSession();
    const list = vi.spyOn(env.FILES, "list");
    const response = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/reconcile", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://cdn.example.test" },
      }),
    );

    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it("preserves invitation logout behavior for the exact upload origin", async () => {
    const cookie = await createTestInvitationSession();
    const rejected = await exports.default.fetch(
      new Request("https://upload.example.test/api/invitations/session", {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: "https://cdn.example.test" },
      }),
    );
    expect(rejected.status).toBe(403);

    const accepted = await exports.default.fetch(
      new Request("https://upload.example.test/api/invitations/session", {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: TEST_UPLOAD_ORIGIN },
      }),
    );
    expect(accepted.status).toBe(204);
    const session = await exports.default.fetch(
      new Request("https://upload.example.test/api/invitations/session", {
        headers: { Cookie: cookie },
      }),
    );
    expect(session.status).toBe(401);
  });
});
