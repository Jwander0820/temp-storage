import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { reserveQuotaAndCreateRecords } from "../src/repositories/quota-repository";
import { purgeDeletedMetadata } from "../src/repositories/file-repository";
import { completeUpload } from "../src/repositories/upload-repository";
import { runCleanup } from "../src/services/cleanup-service";
import {
  createTestInvitation,
  resetState,
  TEST_INVITATION_ID,
  TEST_UPLOAD_RATE_LIMITS,
} from "./helpers";

describe("cleanup", () => {
  beforeEach(async () => {
    await resetState();
    await createTestInvitation({ now: 1_800_000_000 });
  });

  it("releases expired reservations", async () => {
    const now = 1_800_000_000;
    await reserveQuotaAndCreateRecords(
      env.DB,
      {
        eventId: "expired-event",
        reservationId: "expired-upload",
        fileId: "expired-file",
        objectKey: "temp-storage/objects/2027/01/15/expired-file",
        filename: "expired.bin",
        extension: "bin",
        declaredMime: "application/octet-stream",
        sizeBytes: 25,
        uploaderHash: "uploader",
        previousUploaderHash: "previous",
        invitationId: TEST_INVITATION_ID,
        createdAt: now - 1000,
        reservationExpiresAt: now - 100,
        fileExpiresAt: now + 1000,
      },
      TEST_UPLOAD_RATE_LIMITS,
    );

    const result = await runCleanup(env, now);
    expect(result.expiredReservations).toBe(1);
    const usage = await env.DB.prepare(
      "SELECT reserved_bytes FROM storage_usage WHERE id = 1",
    ).first<{ reserved_bytes: number }>();
    expect(usage?.reserved_bytes).toBe(0);
  });

  it("deletes expired active objects and updates used bytes once", async () => {
    const now = 1_800_000_000;
    await reserveQuotaAndCreateRecords(
      env.DB,
      {
        eventId: "active-event",
        reservationId: "active-upload",
        fileId: "active-file",
        objectKey: "temp-storage/objects/2027/01/15/active-file",
        filename: "active.bin",
        extension: "bin",
        declaredMime: "application/octet-stream",
        sizeBytes: 4,
        uploaderHash: "uploader",
        previousUploaderHash: "previous",
        invitationId: TEST_INVITATION_ID,
        createdAt: now - 1000,
        reservationExpiresAt: now + 100,
        fileExpiresAt: now - 1,
      },
      TEST_UPLOAD_RATE_LIMITS,
    );
    await env.DB.prepare("UPDATE files SET status = 'uploading' WHERE id = 'active-file'").run();
    await env.FILES.put(
      "temp-storage/objects/2027/01/15/active-file",
      new Uint8Array([1, 2, 3, 4]),
    );
    await completeUpload(env.DB, {
      uploadId: "active-upload",
      sizeBytes: 4,
      detectedMime: "application/octet-stream",
      previewPolicy: "download_only",
      deleteTokenHash: "a".repeat(64),
      now: now - 500,
    });

    const first = await runCleanup(env, now);
    const second = await runCleanup(env, now);
    expect(first.deletedCount).toBe(1);
    expect(second.deletedCount).toBe(0);
    expect(await env.FILES.head("temp-storage/objects/2027/01/15/active-file")).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'active-file'").first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM upload_reservations WHERE id = 'active-upload'").first(),
    ).not.toBeNull();

    const usageBeforePurge = await env.DB.prepare(
      "SELECT used_bytes FROM storage_usage WHERE id = 1",
    ).first<{ used_bytes: number }>();
    const afterRetention = await runCleanup(env, now + 604_801);
    const usageAfterPurge = await env.DB.prepare(
      "SELECT used_bytes FROM storage_usage WHERE id = 1",
    ).first<{ used_bytes: number }>();
    expect(afterRetention.purgedMetadata).toBe(1);
    expect(usageBeforePurge?.used_bytes).toBe(0);
    expect(usageAfterPurge).toEqual(usageBeforePurge);
    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'active-file'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM upload_reservations WHERE id = 'active-upload'").first(),
    ).toBeNull();
  });

  it("purges deleted metadata child-first in deterministic batches", async () => {
    const cutoff = 1_800_000_000;
    for (const [index, deletedAt] of [cutoff - 30, cutoff - 20, cutoff - 10].entries()) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO files (
             id, object_key, original_name, size_bytes, status,
             created_at, expires_at, deleted_at
           ) VALUES (?1, ?2, ?3, 1, 'deleted', ?4, ?5, ?6)`,
        ).bind(
          `deleted-file-${index}`,
          `temp-storage/objects/2027/01/15/deleted-file-${index}`,
          `deleted-${index}.bin`,
          deletedAt - 100,
          deletedAt - 1,
          deletedAt,
        ),
        env.DB.prepare(
          `INSERT INTO upload_reservations (
             id, file_id, reserved_bytes, status, created_at, expires_at, quota_released_at
           ) VALUES (?1, ?2, 1, 'consumed', ?3, ?4, ?5)`,
        ).bind(
          `deleted-upload-${index}`,
          `deleted-file-${index}`,
          deletedAt - 100,
          deletedAt - 50,
          deletedAt - 50,
        ),
      ]);
    }
    await env.DB.prepare(
      `INSERT INTO files (
         id, object_key, original_name, size_bytes, status,
         created_at, expires_at, deleted_at
       ) VALUES (
         'retained-failed',
         'temp-storage/objects/2027/01/15/retained-failed',
         'retained-failed.bin',
         1,
         'failed',
         ?1,
         ?2,
         ?3
       )`,
    )
      .bind(cutoff - 200, cutoff - 100, cutoff - 50)
      .run();

    expect(await purgeDeletedMetadata(env.DB, cutoff, 2)).toBe(2);
    const firstBatchFiles = await env.DB.prepare(
      "SELECT id FROM files WHERE status = 'deleted' ORDER BY deleted_at, id",
    ).all<{ id: string }>();
    expect(firstBatchFiles.results.map((file) => file.id)).toEqual(["deleted-file-2"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM upload_reservations WHERE file_id LIKE 'deleted-file-%'",
      ).first<{ count: number }>(),
    ).toMatchObject({ count: 1 });

    expect(await purgeDeletedMetadata(env.DB, cutoff, 2)).toBe(1);
    expect(await purgeDeletedMetadata(env.DB, cutoff, 2)).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM files WHERE id LIKE 'deleted-file-%'",
      ).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM upload_reservations WHERE file_id LIKE 'deleted-file-%'",
      ).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'retained-failed'").first(),
    ).not.toBeNull();
  });
});
