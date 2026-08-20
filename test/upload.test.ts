import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedUpload } from "./helpers";
import { createTestInvitationSession, mockSuccessfulTurnstile, resetState } from "./helpers";

let sessionCookie = "";

async function reserve(filename: string, bytes: Uint8Array, declaredMime: string) {
  const response = await exports.default.fetch(
    new Request("https://upload.example.test/api/uploads/reserve", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "application/json",
        Cookie: sessionCookie,
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
    expect(result.previewUrl).toBe(`https://cdn.example.test/p/${result.id}`);
    expect(result.downloadUrl).toBe(`https://cdn.example.test/d/${result.id}`);

    const storedToken = await env.DB.prepare("SELECT delete_token_hash FROM files WHERE id = ?1")
      .bind(result.id)
      .first<{ delete_token_hash: string }>();
    expect(storedToken?.delete_token_hash).not.toBe(result.deleteToken);

    const preview = await exports.default.fetch(
      new Request(`https://cdn.example.test/p/${result.id}`),
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/jpeg");
    expect(preview.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);

    const ranged = await exports.default.fetch(
      new Request(`https://cdn.example.test/p/${result.id}`, {
        headers: { Range: "bytes=1-3" },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 1-3/${bytes.byteLength}`);
    expect(ranged.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(1, 4));

    const head = await exports.default.fetch(
      new Request(`https://cdn.example.test/p/${result.id}`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("forces ZIP downloads and hides them from preview", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const { result } = await upload("archive.zip", bytes, "application/zip");

    const preview = await exports.default.fetch(
      new Request(`https://cdn.example.test/p/${result.id}`),
    );
    expect(preview.status).toBe(404);

    const download = await exports.default.fetch(
      new Request(`https://cdn.example.test/d/${result.id}`),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
  });

  it("blocks active content disguised as an image and releases quota", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const reservation = await reserve("photo.jpg", bytes, "image/jpeg");
    const response = await exports.default.fetch(
      new Request(`https://upload.example.test${reservation.uploadUrl}`, {
        method: "PUT",
        headers: { "Content-Length": String(bytes.byteLength), Cookie: sessionCookie },
        body: bytes,
      }),
    );
    expect(response.status).toBe(400);

    const usage = await env.DB.prepare(
      "SELECT used_bytes, reserved_bytes FROM storage_usage WHERE id = 1",
    ).first<{ used_bytes: number; reserved_bytes: number }>();
    expect(usage).toEqual({ used_bytes: 0, reserved_bytes: 0 });
  });

  it("deletes idempotently with the one-time delete token", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { result } = await upload("delete-me.jpg", bytes, "image/jpeg");
    const request = () =>
      exports.default.fetch(
        new Request(`https://upload.example.test/api/files/${result.id}`, {
          method: "DELETE",
          headers: { Authorization: `DeleteToken ${result.deleteToken}` },
        }),
      );

    expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(204);
    expect(
      (await exports.default.fetch(new Request(`https://cdn.example.test/p/${result.id}`))).status,
    ).toBe(404);
  });
});
