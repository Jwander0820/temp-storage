import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSuccessfulTurnstile, resetState } from "./helpers";

const adminToken = "test-admin-token-32-bytes-minimum";

async function login(token = adminToken): Promise<Response> {
  return exports.default.fetch(
    new Request("https://upload.example.test/api/admin/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ turnstileToken: "test-admin-challenge" }),
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
    expect(setCookie).toContain("Path=/api/admin");
    expect(setCookie).not.toContain(adminToken);
    const cookie = setCookie.split(";", 1)[0] ?? setCookie;

    const session = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/session", {
        headers: { Cookie: cookie },
      }),
    );
    expect(session.status).toBe(200);
    expect(session.headers.get("Cache-Control")).toBe("private, no-store");

    const created = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/invitations", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
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

    const listed = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/invitations", {
        headers: { Cookie: cookie },
      }),
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(listed.json()).resolves.toMatchObject({
      invitations: [{ label: "手機建立", status: "active", usedFiles: 0, unlimitedFiles: true }],
    });

    const revoked = await exports.default.fetch(
      new Request(
        `https://upload.example.test/api/admin/invitations/${createdPayload.id}`,
        { method: "DELETE", headers: { Cookie: cookie } },
      ),
    );
    expect(revoked.status).toBe(204);
    expect(revoked.headers.get("Cache-Control")).toBe("private, no-store");

    const history = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/invitations", {
        headers: { Cookie: cookie },
      }),
    );
    await expect(history.json()).resolves.toMatchObject({
      invitations: [{ label: "手機建立", status: "revoked" }],
    });

    const logout = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/session", {
        method: "DELETE",
        headers: { Cookie: cookie },
      }),
    );
    expect(logout.status).toBe(204);
    expect(
      (
        await exports.default.fetch(
          new Request("https://upload.example.test/api/admin/session", {
            headers: { Cookie: cookie },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("rejects an invalid admin token before Turnstile verification", async () => {
    const response = await login("wrong-admin-token");
    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
