import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_INVITATION_ID,
  createTestInvitation,
  createTestInvitationSession,
  mockSuccessfulTurnstile,
  resetState,
} from "./helpers";

const adminToken = "test-admin-token-32-bytes-minimum";
let sessionCookie = "";
let fileSequence = 0;

interface InsertFileOptions {
  readonly id?: string;
  readonly invitationId?: string;
  readonly status?:
    "reserved" | "uploading" | "active" | "deleting" | "deleted" | "rejected" | "failed";
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly mime?: string;
  readonly previewPolicy?: "inline" | "download_only" | "blocked" | null;
  readonly filename?: string;
  readonly sizeBytes?: number;
}

async function insertFile(options: InsertFileOptions = {}): Promise<string> {
  fileSequence += 1;
  const now = Math.floor(Date.now() / 1000);
  const id = options.id ?? `${String.fromCharCode(64 + fileSequence).repeat(21)}${fileSequence}`;
  const status = options.status ?? "active";
  const mime = options.mime ?? "text/plain";
  const previewPolicy = options.previewPolicy ?? "download_only";
  await env.DB.prepare(
    `INSERT INTO files (
       id, object_key, original_name, extension, declared_mime, detected_mime,
       size_bytes, preview_policy, status, created_at, expires_at, deleted_at,
       delete_token_hash, uploader_hash, sha256, invitation_id
     ) VALUES (?1, ?2, ?3, 'txt', ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      id,
      `temp-storage/objects/2026/08/26/${id}`,
      options.filename ?? `${id}.txt`,
      mime,
      options.sizeBytes ?? fileSequence,
      previewPolicy,
      status,
      options.createdAt ?? now - fileSequence,
      options.expiresAt ?? now + 86_400,
      status === "deleted" ? now : null,
      "d".repeat(64),
      "u".repeat(64),
      "s".repeat(64),
      options.invitationId ?? TEST_INVITATION_ID,
    )
    .run();
  return id;
}

async function browse(path = "/api/files"): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://upload.example.test${path}`, { headers: { Cookie: sessionCookie } }),
  );
}

describe("shared file browser", () => {
  beforeEach(async () => {
    await resetState();
    mockSuccessfulTurnstile();
    sessionCookie = await createTestInvitationSession();
    fileSequence = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects anonymous collection requests without exposing file data", async () => {
    await insertFile();
    const response = await exports.default.fetch(
      new Request("https://upload.example.test/api/files"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json<Record<string, unknown>>();
    expect(payload).not.toHaveProperty("files");
    expect(payload).toMatchObject({ error: { code: "INVITATION_REQUIRED" } });
  });

  it("lists active unexpired files across invitations and omits internal fields", async () => {
    const now = Math.floor(Date.now() / 1000);
    await createTestInvitation({ id: "invitation-b", now });
    const imageId = await insertFile({
      invitationId: TEST_INVITATION_ID,
      mime: "image/jpeg",
      previewPolicy: "inline",
      filename: "shared-photo.jpg",
      createdAt: now,
    });
    const textId = await insertFile({
      invitationId: "invitation-b",
      filename: "from-b.txt",
      createdAt: now - 1,
    });
    for (const status of [
      "reserved",
      "uploading",
      "deleting",
      "deleted",
      "rejected",
      "failed",
    ] as const) {
      await insertFile({ status, invitationId: "invitation-b" });
    }
    await insertFile({ expiresAt: now, invitationId: "invitation-b" });

    const response = await browse();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json<{ files: Array<Record<string, unknown>> }>();
    expect(payload.files.map((file) => file.id)).toEqual([imageId, textId]);
    for (const file of payload.files) {
      expect(file).not.toHaveProperty("object_key");
      expect(file).not.toHaveProperty("delete_token_hash");
      expect(file).not.toHaveProperty("uploader_hash");
      expect(file).not.toHaveProperty("sha256");
      expect(file).not.toHaveProperty("invitation_id");
    }
    await expect((await browse("/api/files?type=image")).json()).resolves.toMatchObject({
      files: [{ id: imageId }],
    });
    await expect((await browse("/api/files?type=other")).json()).resolves.toMatchObject({
      files: [{ id: textId }],
    });
    const rateEvents = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_events",
    ).first<{
      count: number;
    }>();
    expect(rateEvents?.count).toBe(0);
  });

  it("paginates identical timestamps without duplicates or omissions", async () => {
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const firstId = "B".repeat(22);
    const secondId = "A".repeat(22);
    await insertFile({ id: secondId, createdAt });
    await insertFile({ id: firstId, createdAt });

    const first = await (
      await browse("/api/files?limit=1")
    ).json<{
      files: Array<{ id: string }>;
      nextCursor: string;
    }>();
    expect(first.files.map((file) => file.id)).toEqual([firstId]);
    expect(first.nextCursor).toBeTruthy();
    const second = await (
      await browse(`/api/files?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json<{ files: Array<{ id: string }>; nextCursor: null }>();
    expect(second.files.map((file) => file.id)).toEqual([secondId]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects invalid cursors, limits, and type filters", async () => {
    for (const query of [
      "cursor=not-a-valid-cursor",
      "limit=0",
      "limit=61",
      "limit=1.5",
      "limit=nope",
      "type=application%2Fsql",
    ]) {
      const response = await browse(`/api/files?${query}`);
      expect(response.status, query).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }
  });

  it("revalidates invitation revocation on every request", async () => {
    expect((await browse()).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE upload_invitations SET status = 'revoked', revoked_at = ?1 WHERE id = ?2",
    )
      .bind(now, TEST_INVITATION_ID)
      .run();
    expect((await browse()).status).toBe(401);
  });

  it("revalidates session expiry on every request", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE upload_sessions SET created_at = ?1, expires_at = ?2 WHERE invitation_id = ?3",
    )
      .bind(now - 10, now - 1, TEST_INVITATION_ID)
      .run();
    expect((await browse()).status).toBe(401);
  });

  it("rate limits extreme repeated collection reads without writing upload rate events", async () => {
    let response: Response | null = null;
    for (let index = 0; index <= 120; index += 1) {
      response = await browse();
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    const rateEvents = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_events",
    ).first<{ count: number }>();
    expect(rateEvents?.count).toBe(0);
  });

  it("lets an admin session list and delete an active file exactly once", async () => {
    vi.restoreAllMocks();
    mockSuccessfulTurnstile("admin");
    const fileId = await insertFile({ sizeBytes: 4, filename: "delete-me.txt" });
    await insertFile({
      filename: "expired-but-active.txt",
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    const objectKey = `temp-storage/objects/2026/08/26/${fileId}`;
    await env.FILES.put(objectKey, new Uint8Array([1, 2, 3, 4]));
    await env.DB.prepare("UPDATE storage_usage SET used_bytes = 4 WHERE id = 1").run();

    const login = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnstileToken: "test-admin-challenge" }),
      }),
    );
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0] ?? "";
    const adminHeaders = { Cookie: cookie };

    const listed = await exports.default.fetch(
      new Request("https://upload.example.test/api/admin/files?status=active", {
        headers: adminHeaders,
      }),
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
    const listPayload = await listed.json<{ files: Array<Record<string, unknown>> }>();
    expect(listPayload.files).toMatchObject([
      {
        id: fileId,
        filename: "delete-me.txt",
        downloadUrl: `https://upload.example.test/d/${fileId}`,
      },
    ]);
    expect(listPayload.files).toHaveLength(1);
    expect(listPayload.files[0]).not.toHaveProperty("object_key");

    const remove = () =>
      exports.default.fetch(
        new Request(`https://upload.example.test/api/admin/files/${fileId}`, {
          method: "DELETE",
          headers: adminHeaders,
        }),
      );
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(204);
    expect(
      (await exports.default.fetch(new Request(`https://upload.example.test/api/files/${fileId}`)))
        .status,
    ).toBe(404);
    expect(
      (await exports.default.fetch(new Request(`https://upload.example.test/d/${fileId}`))).status,
    ).toBe(404);
    const usage = await env.DB.prepare("SELECT used_bytes FROM storage_usage WHERE id = 1").first<{
      used_bytes: number;
    }>();
    expect(usage?.used_bytes).toBe(0);
  });
});
