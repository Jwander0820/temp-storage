import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedUpload } from "./helpers";
import {
  createTestAdminSession,
  createTestInvitationSession,
  mockSuccessfulTurnstile,
  resetState,
  TEST_UPLOAD_ORIGIN,
} from "./helpers";

let sessionCookie = "";

async function reserve(filename: string, bytes: Uint8Array, declaredMime: string) {
  const response = await exports.default.fetch(
    new Request("https://upload.example.test/api/uploads/reserve", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "application/json",
        Cookie: sessionCookie,
        Origin: TEST_UPLOAD_ORIGIN,
      },
      body: JSON.stringify({
        filename,
        sizeBytes: bytes.byteLength,
        declaredMime,
      }),
    }),
  );
  expect(response.status).toBe(200);
  return response.json<{ uploadId: string; uploadUrl: string }>();
}

async function upload(
  filename: string,
  bytes: Uint8Array,
  declaredMime: string,
): Promise<{ response: Response; result: CompletedUpload }> {
  const reservation = await reserve(filename, bytes, declaredMime);
  const response = await exports.default.fetch(
    new Request(`https://upload.example.test${reservation.uploadUrl}`, {
      method: "PUT",
      headers: {
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "application/octet-stream",
        Cookie: sessionCookie,
        Origin: TEST_UPLOAD_ORIGIN,
      },
      body: bytes,
    }),
  );
  const result = await response.clone().json<CompletedUpload>();
  return { response, result };
}

describe("upload, preview, download, and delete", () => {
  beforeEach(async () => {
    await resetState();
    mockSuccessfulTurnstile();
    sessionCookie = await createTestInvitationSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads and previews a JPEG with range and HEAD support", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x11, 0x22, 0xd9]);
    const { response, result } = await upload("照片.jpg", bytes, "image/jpeg");

    expect(response.status).toBe(200);
    expect(result.detectedMime).toBe("image/jpeg");
    expect(result.previewPolicy).toBe("inline");
    expect(result.deleteToken.length).toBeGreaterThan(40);
    expect(result.deleteUrl).toBe(
      `https://upload.example.test/delete/${result.id}#token=${result.deleteToken}`,
    );
    const storedFile = await env.DB.prepare("SELECT object_key FROM files WHERE id = ?1")
      .bind(result.id)
      .first<{ object_key: string }>();
    expect(storedFile?.object_key).toMatch(
      /^temp-storage\/objects\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]{22}$/u,
    );
    expect(result.previewUrl).toBe(`https://cdn.example.test/${storedFile?.object_key}`);
    expect(result.downloadUrl).toBe(`https://upload.example.test/d/${result.id}`);

    const storedObject = await env.FILES.head(storedFile?.object_key ?? "");
    expect(storedObject?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(storedObject?.httpMetadata?.contentDisposition).toContain("inline");
    expect(storedObject?.httpMetadata?.cacheControl).toBe("public, max-age=3600");

    const storedToken = await env.DB.prepare("SELECT delete_token_hash FROM files WHERE id = ?1")
      .bind(result.id)
      .first<{ delete_token_hash: string }>();
    expect(storedToken?.delete_token_hash).not.toBe(result.deleteToken);

    const preview = await exports.default.fetch(
      new Request(`https://upload.example.test/p/${result.id}`),
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/jpeg");
    expect(preview.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);

    const ranged = await exports.default.fetch(
      new Request(`https://upload.example.test/p/${result.id}`, {
        headers: { Range: "bytes=1-3" },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 1-3/${bytes.byteLength}`);
    expect(ranged.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(1, 4));

    const head = await exports.default.fetch(
      new Request(`https://upload.example.test/p/${result.id}`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("forces ZIP downloads and hides them from preview", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const { result } = await upload("archive.zip", bytes, "application/zip");
    expect(result.previewUrl).toBeNull();
    expect(result.downloadUrl).toBe(`https://upload.example.test/d/${result.id}`);

    const preview = await exports.default.fetch(
      new Request(`https://upload.example.test/p/${result.id}`),
    );
    expect(preview.status).toBe(404);

    const download = await exports.default.fetch(
      new Request(`https://upload.example.test/d/${result.id}`),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("cache-control")).toBe("private, no-store");

    const storedFile = await env.DB.prepare("SELECT object_key FROM files WHERE id = ?1")
      .bind(result.id)
      .first<{ object_key: string }>();
    const storedObject = await env.FILES.head(storedFile?.object_key ?? "");
    expect(storedObject?.httpMetadata?.contentDisposition).toContain("attachment");
    expect(storedObject?.httpMetadata?.cacheControl).toBe("private, no-store");
  });

  it("blocks active content disguised as an image and releases quota", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const reservation = await reserve("photo.jpg", bytes, "image/jpeg");
    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.byteLength),
          Cookie: sessionCookie,
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: bytes,
      }),
    );
    expect(response.status).toBe(400);

    const usage = await env.DB.prepare(
      "SELECT used_bytes, reserved_bytes FROM storage_usage WHERE id = 1",
    ).first<{ used_bytes: number; reserved_bytes: number }>();
    expect(usage).toEqual({ used_bytes: 0, reserved_bytes: 0 });
  });

  it("keeps the committed object and ledger when response finalization fails", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x11, 0x22, 0xd9]);
    const reservation = await reserve("committed.jpg", bytes, "image/jpeg");
    const reserved = await env.DB.prepare(
      `SELECT f.object_key
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{ object_key: string }>();

    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      if (typeof message === "string" && message.includes('"event":"upload.completed"')) {
        throw new Error("forced post-commit response failure");
      }
    });

    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.byteLength),
          Cookie: sessionCookie,
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(500);
    const state = await env.DB.prepare(
      `SELECT f.status AS file_status, r.status AS reservation_status,
              usage.used_bytes, usage.reserved_bytes
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       JOIN storage_usage usage ON usage.id = 1
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{
        file_status: string;
        reservation_status: string;
        used_bytes: number;
        reserved_bytes: number;
      }>();
    expect(state).toEqual({
      file_status: "active",
      reservation_status: "consumed",
      used_bytes: bytes.byteLength,
      reserved_bytes: 0,
    });
    expect(await env.FILES.head(reserved?.object_key ?? "missing")).not.toBeNull();
  });

  it("rolls back the object and reservation when the ledger commit fails", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const reservation = await reserve("commit-fails.jpg", bytes, "image/jpeg");
    const reserved = await env.DB.prepare(
      `SELECT f.object_key
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{ object_key: string }>();
    await env.DB.prepare(
      `CREATE TRIGGER fail_upload_commit
       BEFORE UPDATE OF status ON upload_reservations
       WHEN NEW.status = 'consumed'
       BEGIN
         SELECT RAISE(ABORT, 'forced upload commit failure');
       END`,
    ).run();

    try {
      const response = await exports.default.fetch(
        new Request(`https://upload.example.test${reservation.uploadUrl}`, {
          method: "PUT",
          headers: {
            "Content-Length": String(bytes.byteLength),
            Cookie: sessionCookie,
            Origin: TEST_UPLOAD_ORIGIN,
          },
          body: bytes,
        }),
      );
      expect(response.status).toBe(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_upload_commit").run();
    }

    const state = await env.DB.prepare(
      `SELECT f.status AS file_status, r.status AS reservation_status,
              usage.used_bytes, usage.reserved_bytes
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       JOIN storage_usage usage ON usage.id = 1
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{
        file_status: string;
        reservation_status: string;
        used_bytes: number;
        reserved_bytes: number;
      }>();
    expect(state).toEqual({
      file_status: "failed",
      reservation_status: "cancelled",
      used_bytes: 0,
      reserved_bytes: 0,
    });
    expect(await env.FILES.head(reserved?.object_key ?? "missing")).toBeNull();
  });

  it("does not classify a blocked type as a generic upload failure", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const reservation = await reserve("blocked.jpg", bytes, "image/jpeg");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.byteLength),
          Cookie: sessionCookie,
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(400);
    expect(errorLog.mock.calls.flat().join("\n")).not.toContain('"event":"upload.failed"');
    const state = await env.DB.prepare(
      `SELECT f.status AS file_status, r.status AS reservation_status
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{ file_status: string; reservation_status: string }>();
    expect(state).toEqual({ file_status: "rejected", reservation_status: "cancelled" });
  });

  it("releases the reservation when the R2 put fails", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const reservation = await reserve("put-fails.jpg", bytes, "image/jpeg");
    vi.spyOn(env.FILES, "put").mockRejectedValueOnce(new Error("forced R2 put failure"));

    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.byteLength),
          Cookie: sessionCookie,
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(500);
    const state = await env.DB.prepare(
      `SELECT f.status AS file_status, r.status AS reservation_status,
              usage.used_bytes, usage.reserved_bytes
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       JOIN storage_usage usage ON usage.id = 1
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{
        file_status: string;
        reservation_status: string;
        used_bytes: number;
        reserved_bytes: number;
      }>();
    expect(state).toEqual({
      file_status: "failed",
      reservation_status: "cancelled",
      used_bytes: 0,
      reserved_bytes: 0,
    });
  });

  it("releases quota and preserves the size error when R2 rollback deletion fails", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const reservation = await reserve("size-mismatch.jpg", bytes, "image/jpeg");
    const originalPut = env.FILES.put.bind(env.FILES);
    vi.spyOn(env.FILES, "put").mockImplementationOnce(async (...args) => {
      const stored = await originalPut(...args);
      if (stored === null) {
        throw new Error("Test setup could not store the R2 object.");
      }
      return new Proxy(stored, {
        get(target, property, receiver) {
          if (property === "size") {
            return bytes.byteLength - 1;
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    });
    vi.spyOn(env.FILES, "delete").mockRejectedValueOnce(new Error("forced R2 delete failure"));

    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.byteLength),
          Cookie: sessionCookie,
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FILE_SIZE_MISMATCH" },
    });
    const state = await env.DB.prepare(
      `SELECT f.status AS file_status, r.status AS reservation_status,
              usage.used_bytes, usage.reserved_bytes
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       JOIN storage_usage usage ON usage.id = 1
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{
        file_status: string;
        reservation_status: string;
        used_bytes: number;
        reserved_bytes: number;
      }>();
    expect(state).toEqual({
      file_status: "failed",
      reservation_status: "cancelled",
      used_bytes: 0,
      reserved_bytes: 0,
    });
  });

  it("preserves the upload error when reservation rollback also fails", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const reservation = await reserve("rollback-fails.jpg", bytes, "image/jpeg");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env.FILES, "put").mockRejectedValueOnce(new Error("root R2 put failure"));
    vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("reservation rollback failure"));

    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.byteLength),
          Cookie: sessionCookie,
          Origin: TEST_UPLOAD_ORIGIN,
        },
        body: bytes,
      }),
    );

    expect(response.status).toBe(500);
    const logs = errorLog.mock.calls.flat().join("\n");
    expect(logs).toContain('"event":"upload.rollback_reservation_failed"');
    expect(logs).toContain('"message":"reservation rollback failure"');
    expect(logs).toContain('"event":"upload.failed"');
    expect(logs).toContain('"message":"root R2 put failure"');
    expect(logs).toContain('"event":"request.failed"');
    const state = await env.DB.prepare(
      `SELECT f.status AS file_status, r.status AS reservation_status
       FROM files f
       JOIN upload_reservations r ON r.file_id = f.id
       WHERE r.id = ?1`,
    )
      .bind(reservation.uploadId)
      .first<{ file_status: string; reservation_status: string }>();
    expect(state).toEqual({ file_status: "uploading", reservation_status: "reserved" });
  });

  it("deletes idempotently with the one-time delete token", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { result } = await upload("delete-me.jpg", bytes, "image/jpeg");
    const request = () =>
      exports.default.fetch(
        new Request(`https://upload.example.test/api/delete/${result.id}`, {
          method: "DELETE",
          headers: { Authorization: `DeleteToken ${result.deleteToken}` },
        }),
      );

    expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(204);
    const file = await env.DB.prepare("SELECT object_key FROM files WHERE id = ?1")
      .bind(result.id)
      .first<{ object_key: string }>();
    expect(await env.FILES.head(file?.object_key ?? "missing")).toBeNull();
  });

  it("treats an administrator-first deletion as an already completed capability deletion", async () => {
    const { result } = await upload(
      "admin-deleted-first.jpg",
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      "image/jpeg",
    );
    const adminCookie = await createTestAdminSession();
    const adminDelete = await exports.default.fetch(
      new Request(`https://upload.example.test/api/admin/files/${result.id}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie, Origin: TEST_UPLOAD_ORIGIN },
      }),
    );
    expect(adminDelete.status).toBe(204);

    const capabilityDelete = await exports.default.fetch(
      new Request(`https://upload.example.test/api/delete/${result.id}`, {
        method: "DELETE",
        headers: { Authorization: `DeleteToken ${result.deleteToken}` },
      }),
    );
    expect(capabilityDelete.status).toBe(204);
  });

  it("rejects a well-formed token that belongs to a different file", async () => {
    const first = await upload("first.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
    const second = await upload(
      "second.jpg",
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      "image/jpeg",
    );

    const response = await exports.default.fetch(
      new Request(`https://upload.example.test/api/delete/${first.result.id}`, {
        method: "DELETE",
        headers: { Authorization: `DeleteToken ${second.result.deleteToken}` },
      }),
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT status FROM files WHERE id = ?1")
        .bind(first.result.id)
        .first<{ status: string }>(),
    ).toEqual({ status: "active" });
  });

  it("does not route the direct R2 CDN hostname through the Worker", async () => {
    const response = await exports.default.fetch(
      new Request("https://cdn.example.test/temp-storage/objects/example"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
