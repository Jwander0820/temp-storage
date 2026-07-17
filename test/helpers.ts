import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";
import { createInvitation } from "../src/repositories/invitation-repository";
import { createInvitationTokenHash } from "../src/services/invitation-service";

export const TEST_INVITATION_ID = "test-invitation";

export async function resetState(maxBytes = 3221225472): Promise<void> {
  const listed = await env.FILES.list({ prefix: "objects/", limit: 1000 });
  if (listed.objects.length > 0) {
    await env.FILES.delete(listed.objects.map((object) => object.key));
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_sessions"),
    env.DB.prepare("DELETE FROM upload_reservations"),
    env.DB.prepare("DELETE FROM rate_limit_events"),
    env.DB.prepare("DELETE FROM cleanup_runs"),
    env.DB.prepare("DELETE FROM files"),
    env.DB.prepare("DELETE FROM upload_invitations"),
    env.DB.prepare(
      `UPDATE storage_usage
         SET used_bytes = 0,
             reserved_bytes = 0,
             max_bytes = ?1,
             updated_at = unixepoch()
         WHERE id = 1`,
    ).bind(maxBytes),
  ]);
}

export function mockSuccessfulTurnstile(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      Response.json({ success: true, hostname: "upload.example.test", action: "invite" }),
    ),
  );
}

export async function createTestInvitation(options?: {
  readonly id?: string;
  readonly now?: number;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly expiresAt?: number;
}): Promise<string> {
  const id = options?.id ?? TEST_INVITATION_ID;
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  await createInvitation(env.DB, {
    id,
    tokenHash: "0".repeat(64),
    label: "測試邀請",
    maxFiles: options?.maxFiles ?? 100,
    maxBytes: options?.maxBytes ?? 3221225472,
    createdAt: now - 1,
    expiresAt: options?.expiresAt ?? now + 2_592_000,
  });
  return id;
}

export async function createTestInvitationSession(): Promise<string> {
  const token = "A".repeat(43);
  const now = Math.floor(Date.now() / 1000);
  await createInvitation(env.DB, {
    id: TEST_INVITATION_ID,
    tokenHash: await createInvitationTokenHash(env.DELETE_TOKEN_PEPPER, token),
    label: "測試邀請",
    maxFiles: 100,
    maxBytes: 3221225472,
    createdAt: now - 1,
    expiresAt: now + 2_592_000,
  });
  const exchange = await exports.default.fetch(
    new Request("https://upload.example.test/api/invitations/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, turnstileToken: "test-invitation-challenge" }),
    }),
  );
  if (exchange.status !== 200) {
    throw new Error(`Unable to create test invitation session: ${exchange.status}`);
  }
  const setCookie = exchange.headers.get("Set-Cookie");
  if (setCookie === null) {
    throw new Error("Invitation exchange did not set a session cookie.");
  }
  return setCookie.split(";", 1)[0] ?? setCookie;
}

export interface CompletedUpload {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly previewPolicy: "inline" | "download_only";
  readonly previewUrl: string | null;
  readonly downloadUrl: string;
  readonly deleteToken: string;
}
