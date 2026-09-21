import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestAdminSession,
  mockSuccessfulTurnstile,
  resetState,
  TEST_UPLOAD_ORIGIN,
} from "./helpers";
import { runCleanup } from "../src/services/cleanup-service";
import {
  purgeExpiredSessions,
  purgeRetiredInvitationHistory,
} from "../src/repositories/invitation-repository";

interface Credential {
  id: string;
  token: string;
  partitionId: string;
  expiresAt: string;
  maxBytes: number;
  maxFiles: number;
}
let admin = "";
let ip = 0;
const now = () => Math.floor(Date.now() / 1000);

function request(path: string, cookie = admin, method = "GET", body?: unknown) {
  return exports.default.fetch(
    new Request(`${TEST_UPLOAD_ORIGIN}/api${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: TEST_UPLOAD_ORIGIN,
        "Content-Type": "application/json",
        "CF-Connecting-IP": `192.0.2.${++ip}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function issue(options: Record<string, unknown> = {}) {
  const response = await request("/admin/invitations", admin, "POST", {
    label: "憑證 A",
    expiresInSeconds: 604800,
    maxFiles: 10,
    maxBytes: 1024,
    ...options,
  });
  expect(response.status).toBe(201);
  return response.json<Credential>();
}
async function session(token: string) {
  const response = await request("/invitations/exchange", "", "POST", {
    token,
    turnstileToken: "test",
  });
  expect(response.status).toBe(200);
  return response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
}
async function reserve(cookie: string, size = 5) {
  return request("/uploads/reserve", cookie, "POST", {
    filename: "sample.txt",
    declaredMime: "text/plain",
    sizeBytes: size,
  });
}
async function upload(cookie: string) {
  const reservation = await reserve(cookie);
  expect(reservation.status).toBe(200);
  const { uploadId } = await reservation.json<{ uploadId: string }>();
  const response = await put(cookie, uploadId);
  expect(response.status).toBe(200);
  return response.json<{ id: string; expiresAt: string; downloadUrl: string }>();
}
function put(cookie: string, id: string) {
  return exports.default.fetch(
    new Request(`${TEST_UPLOAD_ORIGIN}/api/uploads/${id}`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        Origin: TEST_UPLOAD_ORIGIN,
        "Content-Length": "5",
        "Content-Type": "text/plain",
      },
      body: "hello",
    }),
  );
}
async function ids(cookie: string, query = "") {
  const response = await request(`/files${query}`, cookie);
  expect(response.status).toBe(200);
  const body = await response.json<{ files: { id: string; uploaderLabel?: string }[] }>();
  return body.files.map((f) => f.id);
}
async function editPartition(p: Credential, options: Record<string, unknown> = {}) {
  return request(`/admin/partitions/${p.partitionId}`, admin, "PATCH", {
    label: "Jw 私密區",
    expiresAt: new Date((now() + 14 * 86400) * 1000).toISOString(),
    maxFiles: 10,
    maxBytes: 2048,
    unlimitedFiles: false,
    ...options,
  });
}

describe("private partitions", () => {
  beforeEach(async () => {
    await resetState();
    admin = await createTestAdminSession();
    mockSuccessfulTurnstile();
  });
  afterEach(() => vi.restoreAllMocks());

  it("isolates listings, lets admin filter and attribute uploaders, and preserves public file links", async () => {
    const a = await issue({ partitionLabel: "Jw 私密區" });
    const b = await issue({
      partitionId: a.partitionId,
      label: "憑證 B",
      maxBytes: 1,
      expiresInSeconds: 86400,
    });
    expect(b.maxBytes).toBe(a.maxBytes);
    expect(b.expiresAt).toBe(a.expiresAt);
    const other = await issue({ partitionLabel: "另一區" });
    const shared = await issue();
    const ca = await session(a.token),
      cb = await session(b.token),
      co = await session(other.token),
      cs = await session(shared.token);
    const fa = await upload(ca),
      fb = await upload(cb),
      fo = await upload(co),
      fs = await upload(cs);
    expect((await ids(ca)).sort()).toEqual([fa.id, fb.id].sort());
    expect(await ids(cs)).toEqual([fs.id]);
    expect(await ids(ca, "?partition=shared")).toEqual([fs.id]);
    expect((await request(`/files?partition=${other.partitionId}`, ca)).status).toBe(403);
    expect((await request("/files?partition=all", cs)).status).toBe(403);
    expect((await ids(admin)).sort()).toEqual([fa.id, fb.id, fo.id, fs.id].sort());
    expect((await ids(admin, `?partition=${a.partitionId}`)).sort()).toEqual([fa.id, fb.id].sort());
    const listing = await request(`/files?partition=${a.partitionId}`, admin);
    expect(await listing.text()).toContain("憑證 B");
    const publicFile = await request(`/files/${fa.id}`, "");
    expect(publicFile.status).toBe(200);
    const publicText = await publicFile.text();
    expect(publicText).not.toContain("Jw 私密區");
    expect(publicText).not.toContain("uploaderLabel");
    expect((await exports.default.fetch(new Request(fa.downloadUrl))).status).toBe(200);
  });

  it("reserves shared bytes atomically across credentials and applies live quota changes", async () => {
    const a = await issue({ partitionLabel: "quota", maxBytes: 5 });
    const b = await issue({ partitionId: a.partitionId });
    const ca = await session(a.token),
      cb = await session(b.token);
    const responses = await Promise.all([reserve(ca), reserve(cb)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
    const summary = await (await request("/invitations/session", ca)).json<{ usedBytes: number }>();
    expect(summary.usedBytes).toBe(5);
    expect((await editPartition(a, { maxBytes: 10 })).status).toBe(204);
    expect((await reserve(cb)).status).toBe(200);
    expect((await editPartition(a, { maxBytes: 1 })).status).toBe(204);
    expect((await reserve(ca)).status).toBe(429);
    expect((await request("/files", cb)).status).toBe(200);
  });

  it("shares file counts and preserves browse-only enforcement", async () => {
    const a = await issue({ partitionLabel: "counts", maxFiles: 1 });
    const b = await issue({ partitionId: a.partitionId });
    const reader = await issue({ partitionId: a.partitionId, canUpload: false });
    const ca = await session(a.token),
      cb = await session(b.token),
      cr = await session(reader.token);
    const file = await upload(ca);
    expect((await reserve(cb)).status).toBe(429);
    expect((await reserve(cr)).status).toBe(403);
    expect(await ids(cr)).toEqual([file.id]);
    expect((await editPartition(a, { unlimitedFiles: true })).status).toBe(204);
    expect((await reserve(cb)).status).toBe(200);
  });

  it("revokes credentials independently and deletes only when the last one is revoked", async () => {
    const a = await issue({ partitionLabel: "revoke" });
    const b = await issue({ partitionId: a.partitionId });
    const shared = await issue();
    const ca = await session(a.token),
      cb = await session(b.token),
      cs = await session(shared.token);
    const fa = await upload(ca),
      fs = await upload(cs);
    expect((await request(`/admin/invitations/${a.id}`, admin, "DELETE")).status).toBe(204);
    expect((await request("/files", ca)).status).toBe(401);
    expect(await ids(cb)).toEqual([fa.id]);
    expect((await request(`/admin/invitations/${b.id}`, admin, "DELETE")).status).toBe(204);
    expect((await request(`/files/${fa.id}`, "")).status).toBe(404);
    expect(await ids(cs)).toEqual([fs.id]);
    const objects = await env.FILES.list();
    expect(objects.objects).toHaveLength(1);
    expect((await editPartition(a)).status).toBe(409);
    expect((await request(`/admin/invitations/${a.id}/copy`, admin, "POST")).status).toBe(409);
  });

  it("retries failed R2 deletion without double charging and invalidates every credential", async () => {
    const a = await issue({ partitionLabel: "retry" });
    const b = await issue({ partitionId: a.partitionId });
    const ca = await session(a.token),
      cb = await session(b.token);
    const fa = await upload(ca);
    vi.spyOn(env.FILES, "delete").mockRejectedValueOnce(new Error("temporary R2 failure"));
    const deletion = await request(`/admin/partitions/${a.partitionId}`, admin, "DELETE");
    expect(await deletion.json()).toMatchObject({ failed: 1 });
    expect((await request("/files", ca)).status).toBe(401);
    expect((await request("/files", cb)).status).toBe(401);
    expect((await request(`/files/${fa.id}`, "")).status).toBe(404);
    expect((await runCleanup(env)).deletedCount).toBe(1);
    await request(`/admin/partitions/${a.partitionId}`, admin, "DELETE");
    expect(
      await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM storage_usage").first(),
    ).toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
  });

  it("expires private files and reservations while retaining files from expired general invitations", async () => {
    const a = await issue({ partitionLabel: "expiry", expiresInSeconds: 86400 });
    const shared = await issue({ expiresInSeconds: 86400 });
    const ca = await session(a.token),
      cs = await session(shared.token);
    const fa = await upload(ca),
      fs = await upload(cs);
    await reserve(ca);
    const result = await runCleanup(env, now() + 86401);
    // The expired reservation's failed-upload record is finalized as well.
    expect(result.deletedCount).toBe(2);
    expect(result.expiredReservations).toBe(1);
    expect((await request(`/files/${fa.id}`, "")).status).toBe(404);
    expect((await request(`/files/${fs.id}`, "")).status).toBe(200);
  });

  it("extends existing files up to their original 90-day ceiling and keeps extended sessions valid", async () => {
    const a = await issue({ partitionLabel: "extend", expiresInSeconds: 86400 });
    const ca = await session(a.token);
    const file = await upload(ca);
    expect(Date.parse(file.expiresAt)).toBe(Date.parse(a.expiresAt));
    expect(
      (await editPartition(a, { expiresAt: new Date((now() + 180 * 86400) * 1000).toISOString() }))
        .status,
    ).toBe(204);
    const metadata = await (
      await request(`/files/${file.id}`, "")
    ).json<{ createdAt: string; expiresAt: string }>();
    expect(Date.parse(metadata.expiresAt) - Date.parse(metadata.createdAt)).toBe(90 * 86400 * 1000);
    const future = now() + 2 * 86400;
    vi.spyOn(Date, "now").mockReturnValue(future * 1000);
    const extended = await session(a.token);
    await purgeExpiredSessions(env.DB, future);
    expect((await request("/files", extended)).status).toBe(200);
    expect((await request(`/admin/invitations/${a.id}/copy`, admin, "POST")).status).toBe(401); // admin's own short session still expires
  });

  it("does not reset shared consumption when an old revoked credential is eligible for history purge", async () => {
    const a = await issue({ partitionLabel: "history" });
    await issue({ partitionId: a.partitionId });
    const ca = await session(a.token);
    await reserve(ca);
    await request(`/admin/invitations/${a.id}`, admin, "DELETE");
    await env.DB.prepare("UPDATE upload_invitations SET revoked_at = ?1 WHERE id = ?2")
      .bind(now() - 200 * 86400, a.id)
      .run();
    expect(await purgeRetiredInvitationHistory(env.DB, now() - 90 * 86400, 100)).toBe(0);
  });

  it("rolls back an upload when its partition is deleted during object storage", async () => {
    const a = await issue({ partitionLabel: "inflight" });
    const ca = await session(a.token);
    const response = await reserve(ca);
    const { uploadId } = await response.json<{ uploadId: string }>();
    const originalPut = env.FILES.put.bind(env.FILES);
    vi.spyOn(env.FILES, "put").mockImplementationOnce(async (...args) => {
      const stored = await originalPut(...args);
      await request(`/admin/partitions/${a.partitionId}`, admin, "DELETE");
      return stored;
    });
    expect((await put(ca, uploadId)).status).toBe(500);
    expect((await env.FILES.list()).objects).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT used_bytes, reserved_bytes FROM storage_usage").first(),
    ).toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
  });

  it("rejects non-admin mutations and cannot add credentials to a closed partition", async () => {
    const a = await issue({ partitionLabel: "permissions" });
    const ca = await session(a.token);
    expect((await request(`/admin/partitions/${a.partitionId}`, ca, "DELETE")).status).toBe(401);
    expect((await request("/admin/partitions", ca)).status).toBe(401);
    expect((await editPartition(a, { maxBytes: -1 })).status).toBe(400);
    await request(`/admin/partitions/${a.partitionId}`, admin, "DELETE");
    expect(
      (
        await request("/admin/invitations", admin, "POST", {
          label: "late",
          partitionId: a.partitionId,
        })
      ).status,
    ).toBe(409);
  });

  it("cleans failed-upload object remnants only inside a closed private partition", async () => {
    const a = await issue({ partitionLabel: "remnants" });
    const shared = await issue();
    const ca = await session(a.token),
      cs = await session(shared.token);
    const privateFile = await upload(ca),
      sharedFile = await upload(cs);
    // Model a prior failed upload whose R2 rollback failed after quota release.
    await env.DB.prepare("UPDATE files SET status = 'failed' WHERE id IN (?1, ?2)")
      .bind(privateFile.id, sharedFile.id)
      .run();
    await env.DB.prepare("UPDATE storage_usage SET used_bytes = 0").run();
    const deletion = await request(`/admin/partitions/${a.partitionId}`, admin, "DELETE");
    expect(await deletion.json()).toMatchObject({ processed: 1, failed: 0 });
    const objects = await env.FILES.list();
    expect(objects.objects).toHaveLength(1);
    expect(objects.objects[0]?.key).toContain(sharedFile.id);
    expect(await env.DB.prepare("SELECT used_bytes FROM storage_usage").first()).toMatchObject({
      used_bytes: 0,
    });
  });

  it("allows quota edits close to expiry without requiring a one-day extension", async () => {
    const a = await issue({ partitionLabel: "near expiry" });
    const expiry = now() + 3600;
    await env.DB.prepare("UPDATE private_partitions SET expires_at = ?1 WHERE id = ?2")
      .bind(expiry, a.partitionId)
      .run();
    expect(
      (await editPartition(a, { expiresAt: new Date(expiry * 1000).toISOString(), maxBytes: 4096 }))
        .status,
    ).toBe(204);
  });
});
