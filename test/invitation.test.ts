import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSuccessfulTurnstile, resetState } from "./helpers";

const adminHeaders = {
  Authorization: "Bearer test-admin-token-32-bytes-minimum",
  "Content-Type": "application/json",
};

async function createInvitation(options?: { maxFiles?: number; maxBytes?: number }) {
  const response = await exports.default.fetch(
    new Request("https://upload.example.test/api/admin/invitations", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        label: "朋友 A",
        expiresInSeconds: 3600,
        maxFiles: options?.maxFiles ?? 3,
        maxBytes: options?.maxBytes ?? 1024,
      }),
    }),
  );
  expect(response.status).toBe(201);
  return response.json<{ id: string; token: string; inviteUrl: string }>();
}

async function exchange(token: string): Promise<{ response: Response; cookie: string }> {
  const response = await exports.default.fetch(
    new Request("https://upload.example.test/api/invitations/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
  return { response, cookie };
}

describe("upload invitations", () => {
  beforeEach(async () => {
    await resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a hashed invitation and exchanges it for a secure session", async () => {
    const invitation = await createInvitation();
    expect(invitation.token).toHaveLength(43);
    expect(invitation.inviteUrl).toBe(
      `https://upload.example.test/invite#token=${invitation.token}`,
    );

    const stored = await env.DB.prepare("SELECT token_hash FROM upload_invitations WHERE id = ?1")
      .bind(invitation.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toHaveLength(64);
    expect(stored?.token_hash).not.toBe(invitation.token);

    const { response, cookie } = await exchange(invitation.token);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(invitation.token);

    const session = await exports.default.fetch(
      new Request("https://upload.example.test/api/invitations/session", {
        headers: { Cookie: cookie },
      }),
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      label: "朋友 A",
      remainingFiles: 3,
      remainingBytes: 1024,
    });
  });

  it("requires a valid invitation session on every upload endpoint", async () => {
    const reserve = await exports.default.fetch(
      new Request("https://upload.example.test/api/uploads/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(reserve.status).toBe(401);

    const rawUpload = await exports.default.fetch(
      new Request("https://upload.example.test/api/uploads/unknown", {
        method: "PUT",
        headers: { "Content-Length": "1" },
        body: new Uint8Array([1]),
      }),
    );
    expect(rawUpload.status).toBe(401);
  });

  it("enforces invitation file and byte limits independently of the IP limit", async () => {
    const invitation = await createInvitation({ maxFiles: 1, maxBytes: 10 });
    const { cookie } = await exchange(invitation.token);
    mockSuccessfulTurnstile();

    const reserve = (suffix: string) =>
      exports.default.fetch(
        new Request("https://upload.example.test/api/uploads/reserve", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": `203.0.113.${suffix}`,
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({
            filename: `${suffix}.txt`,
            sizeBytes: 1,
            declaredMime: "text/plain",
            turnstileToken: `token-${suffix}`,
          }),
        }),
      );

    expect((await reserve("10")).status).toBe(200);
    const limited = await reserve("11");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "INVITATION_LIMIT_EXCEEDED" },
    });
  });

  it("revokes all sessions for a single invitation", async () => {
    const invitation = await createInvitation();
    const { cookie } = await exchange(invitation.token);
    const revoked = await exports.default.fetch(
      new Request(`https://upload.example.test/api/admin/invitations/${invitation.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }),
    );
    expect(revoked.status).toBe(204);

    expect(
      (
        await exports.default.fetch(
          new Request("https://upload.example.test/api/invitations/session", {
            headers: { Cookie: cookie },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("prevents one invitation session from using another invitation's reservation", async () => {
    const first = await createInvitation();
    const firstSession = await exchange(first.token);
    const secondResponse = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/invitations", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          label: "朋友 B",
          expiresInSeconds: 3600,
          maxFiles: 3,
          maxBytes: 1024,
        }),
      }),
    );
    const second = await secondResponse.json<{ token: string }>();
    const secondSession = await exchange(second.token);
    mockSuccessfulTurnstile();

    const reservationResponse = await exports.default.fetch(
      new Request("https://upload.example.test/api/uploads/reserve", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.20",
          "Content-Type": "application/json",
          Cookie: firstSession.cookie,
        },
        body: JSON.stringify({
          filename: "private.txt",
          sizeBytes: 1,
          declaredMime: "text/plain",
          turnstileToken: "first-token",
        }),
      }),
    );
    const reservation = await reservationResponse.json<{ uploadUrl: string }>();
    const crossedUpload = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": "1",
          Cookie: secondSession.cookie,
        },
        body: new Uint8Array([1]),
      }),
    );
    expect(crossedUpload.status).toBe(404);
  });
});

describe("hostname boundary", () => {
  it("allows only public GET and HEAD media routes on the CDN hostname", async () => {
    expect(
      (await exports.default.fetch(new Request("https://cdn.example.test/api/health"))).status,
    ).toBe(404);
    expect((await exports.default.fetch(new Request("https://cdn.example.test/"))).status).toBe(
      404,
    );
    expect(
      (
        await exports.default.fetch(
          new Request("https://cdn.example.test/p/unknown", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await exports.default.fetch(new Request("https://unknown.example.test/api/health"))).status,
    ).toBe(404);
  });
});
