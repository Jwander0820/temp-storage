import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import { reserveQuotaAndCreateRecords } from "../src/repositories/quota-repository";
import { purgeDeletedMetadata } from "../src/repositories/file-repository";
import { completeUpload } from "../src/repositories/upload-repository";
import { reconcileStorage, runCleanup } from "../src/services/cleanup-service";
import {
  createTestInvitation,
  resetState,
  TEST_INVITATION_ID,
  TEST_UPLOAD_RATE_LIMITS,
} from "./helpers";

describe("cleanup", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.DB.batch([
      env.DB.prepare("DROP TRIGGER IF EXISTS fail_cleanup_purge"),
      env.DB.prepare("DROP TRIGGER IF EXISTS fail_cleanup_finalization"),
    ]);
  });

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

  it("purges released failed upload metadata after its retention window", async () => {
    const now = 1_800_000_000;
    await reserveQuotaAndCreateRecords(
      env.DB,
      {
        eventId: "old-failed-event",
        reservationId: "old-failed-upload",
        fileId: "old-failed-file",
        objectKey: "temp-storage/objects/old-failed-file",
        filename: "old-failed.bin",
        extension: "bin",
        declaredMime: "application/octet-stream",
        sizeBytes: 1,
        uploaderHash: "old-failed-uploader",
        previousUploaderHash: "old-failed-previous",
        invitationId: TEST_INVITATION_ID,
        createdAt: now - 604_801,
        reservationExpiresAt: now - 604_700,
        fileExpiresAt: now + 1_000,
      },
      TEST_UPLOAD_RATE_LIMITS,
    );

    const result = await runCleanup(env, now);
    expect(result.expiredReservations).toBe(1);
    expect(result.purgedFailedUploads).toBe(1);
    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'old-failed-file'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM upload_reservations WHERE id = 'old-failed-upload'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM rate_limit_events WHERE id = 'old-failed-event'",
      ).first(),
    ).not.toBeNull();
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

  it("purges old cleanup runs and unreferenced retired invitation history", async () => {
    const now = 1_800_000_000;
    const retirementCutoff = now - 7_776_000;
    await createTestInvitation({
      id: "retired-invitation",
      now: retirementCutoff - 200,
      expiresAt: retirementCutoff - 100,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO upload_invitation_tokens (token_hash, invitation_id, created_at)
         VALUES (?1, 'retired-invitation', ?2)`,
      ).bind("1".repeat(64), retirementCutoff - 150),
      env.DB.prepare(
        `INSERT INTO upload_sessions (
           id, token_hash, invitation_id, created_at, expires_at
         ) VALUES ('retired-session', ?1, 'retired-invitation', ?2, ?3)`,
      ).bind("2".repeat(64), retirementCutoff - 150, retirementCutoff - 100),
      env.DB.prepare(
        `INSERT INTO rate_limit_events (
           id, uploader_hash, size_bytes, created_at, invitation_id
         ) VALUES ('retired-event', 'retired-uploader', 1, ?1, 'retired-invitation')`,
      ).bind(retirementCutoff - 150),
      env.DB.prepare(
        `INSERT INTO cleanup_runs (id, started_at, finished_at, status)
         VALUES ('old-run', ?1, ?1, 'completed')`,
      ).bind(now - 2_592_001),
      env.DB.prepare(
        `INSERT INTO cleanup_runs (id, started_at, finished_at, status)
         VALUES ('recent-run', ?1, ?1, 'completed')`,
      ).bind(now - 2_592_000 + 1),
    ]);

    const result = await runCleanup(env, now);
    expect(result.purgedCleanupRuns).toBe(1);
    expect(result.purgedInvitationHistory).toBe(1);
    expect(
      await env.DB.prepare("SELECT id FROM cleanup_runs WHERE id = 'old-run'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM cleanup_runs WHERE id = 'recent-run'").first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM upload_invitations WHERE id = 'retired-invitation'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM rate_limit_events WHERE id = 'retired-event'").first(),
    ).toBeNull();
  });

  it("retains retired invitation quota history while file metadata still references it", async () => {
    const now = 1_800_000_000;
    const retirementCutoff = now - 7_776_000;
    await createTestInvitation({
      id: "referenced-retired-invitation",
      now: retirementCutoff - 200,
      expiresAt: retirementCutoff - 100,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (
           id, object_key, original_name, size_bytes, status,
           created_at, expires_at, deleted_at, invitation_id
         ) VALUES (
           'retained-file',
           'temp-storage/objects/retained-file',
           'retained.bin',
           1,
           'deleted',
           ?1,
           ?2,
           ?3,
           'referenced-retired-invitation'
         )`,
      ).bind(retirementCutoff - 150, retirementCutoff - 100, now),
      env.DB.prepare(
        `INSERT INTO rate_limit_events (
           id, uploader_hash, size_bytes, created_at, invitation_id
         ) VALUES (
           'retained-event',
           'retained-uploader',
           1,
           ?1,
           'referenced-retired-invitation'
         )`,
      ).bind(retirementCutoff - 150),
    ]);

    const result = await runCleanup(env, now);
    expect(result.purgedInvitationHistory).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT id FROM upload_invitations WHERE id = 'referenced-retired-invitation'",
      ).first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM rate_limit_events WHERE id = 'retained-event'").first(),
    ).not.toBeNull();
  });

  it("marks a cleanup run failed with the actual finish time after a fatal purge error", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue((now + 9) * 1_000);
    await env.DB.prepare(
      `INSERT INTO upload_sessions (id, token_hash, invitation_id, created_at, expires_at)
       VALUES ('fatal-session', ?1, ?2, ?3, ?4)`,
    )
      .bind("a".repeat(64), TEST_INVITATION_ID, now - 100, now - 1)
      .run();
    await env.DB.prepare(
      `CREATE TRIGGER fail_cleanup_purge
       BEFORE DELETE ON upload_sessions
       BEGIN
         SELECT RAISE(ABORT, 'forced cleanup fatal');
       END`,
    ).run();

    await expect(runCleanup(env, now)).rejects.toThrow(/forced cleanup fatal/u);
    const run = await env.DB.prepare(
      `SELECT started_at, finished_at, status, error_message
       FROM cleanup_runs
       ORDER BY started_at DESC
       LIMIT 1`,
    ).first<{
      started_at: number;
      finished_at: number;
      status: string;
      error_message: string | null;
    }>();
    expect(run).toMatchObject({
      started_at: now,
      finished_at: now + 9,
      status: "failed",
    });
    expect(run?.error_message).toContain("forced cleanup fatal");
  });

  it("preserves the root cleanup error when failed-run finalization also fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare(
      `INSERT INTO upload_sessions (id, token_hash, invitation_id, created_at, expires_at)
       VALUES ('fatal-session', ?1, ?2, ?3, ?4)`,
    )
      .bind("b".repeat(64), TEST_INVITATION_ID, 1_799_999_900, 1_799_999_999)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TRIGGER fail_cleanup_purge
         BEFORE DELETE ON upload_sessions
         BEGIN
           SELECT RAISE(ABORT, 'root cleanup failure');
         END`,
      ),
      env.DB.prepare(
        `CREATE TRIGGER fail_cleanup_finalization
         BEFORE UPDATE ON cleanup_runs
         WHEN NEW.status = 'failed'
         BEGIN
           SELECT RAISE(ABORT, 'finalization failure');
         END`,
      ),
    ]);

    await expect(runCleanup(env, 1_800_000_000)).rejects.toThrow(/root cleanup failure/u);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"cleanup.finalization_failed"'),
    );
  });

  it("paginates through all D1 metadata and R2 objects during reconciliation", async () => {
    const now = Math.floor(Date.now() / 1000) + 7_200;
    const objectKeys = ["page-a", "page-b", "page-c"].map(
      (suffix) => `temp-storage/objects/${suffix}`,
    );
    for (const [index, objectKey] of objectKeys.entries()) {
      await env.FILES.put(objectKey, new Uint8Array([index + 1]));
      await env.DB.prepare(
        `INSERT INTO files (
           id, object_key, original_name, detected_mime, size_bytes,
           preview_policy, status, created_at, expires_at, delete_token_hash
         ) VALUES (?1, ?2, ?3, 'application/octet-stream', 1,
                   'download_only', 'active', ?4, ?5, ?6)`,
      )
        .bind(
          `page-file-${index}`,
          objectKey,
          `page-${index}.bin`,
          now - 100 + index,
          now + 1_000,
          String(index).repeat(64),
        )
        .run();
    }
    await env.DB.prepare("UPDATE storage_usage SET used_bytes = 4 WHERE id = 1").run();
    await env.DB.prepare(
      `INSERT INTO files (
         id, object_key, original_name, detected_mime, size_bytes,
         preview_policy, status, created_at, expires_at, delete_token_hash
       ) VALUES (
         'missing-file',
         'temp-storage/objects/missing-file',
         'missing.bin',
         'application/octet-stream',
         1,
         'download_only',
         'active',
         ?1,
         ?2,
         ?3
       )`,
    )
      .bind(now - 97, now + 1_000, "f".repeat(64))
      .run();
    const orphanKeys = ["orphan-a", "orphan-b", "orphan-c"].map(
      (suffix) => `temp-storage/objects/${suffix}`,
    );
    for (const [index, objectKey] of orphanKeys.entries()) {
      await env.FILES.put(objectKey, new Uint8Array([index + 1]));
    }

    const paginatedEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "RECONCILE_METADATA_LIMIT" || property === "RECONCILE_OBJECT_LIMIT") {
          return "2";
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as unknown as Bindings;
    const results = [];
    let result;
    do {
      result = await reconcileStorage(
        new Proxy(paginatedEnv, {
          get(target, property, receiver) {
            if (property === "RECONCILE_PAGE_BUDGET") {
              return "1";
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
        now,
      );
      results.push(result);
    } while (!result.complete && results.length < 10);

    expect(results[0]).toMatchObject({
      complete: false,
      continuation: { phase: "metadata" },
    });
    expect(results.at(-1)).toMatchObject({ complete: true, continuation: null });
    expect(
      results.reduce(
        (total, current) => ({
          missingObjects: total.missingObjects + current.missingObjects,
          orphanObjects: total.orphanObjects + current.orphanObjects,
          scannedFiles: total.scannedFiles + current.scannedFiles,
          scannedObjects: total.scannedObjects + current.scannedObjects,
        }),
        { missingObjects: 0, orphanObjects: 0, scannedFiles: 0, scannedObjects: 0 },
      ),
    ).toEqual({
      missingObjects: 1,
      orphanObjects: 3,
      scannedFiles: 4,
      scannedObjects: 6,
    });
    expect(
      await env.DB.prepare("SELECT status FROM files WHERE id = 'missing-file'").first(),
    ).toMatchObject({ status: "deleted" });
    for (const objectKey of orphanKeys) {
      expect(await env.FILES.head(objectKey)).toBeNull();
    }
  });

  it("fails closed when the R2 reconciliation cursor does not advance", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO reconciliation_state (
         id, phase, object_cursor, cycle_started_at, updated_at
       ) VALUES (1, 'objects', 'stuck-cursor', ?1, ?1)`,
    )
      .bind(now)
      .run();
    const stuckEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "FILES") {
          return new Proxy(target.FILES, {
            get(bucket, bucketProperty, bucketReceiver) {
              if (bucketProperty === "list") {
                return () =>
                  Promise.resolve({
                    objects: [],
                    truncated: true,
                    cursor: "stuck-cursor",
                    delimitedPrefixes: [],
                  });
              }
              return Reflect.get(bucket, bucketProperty, bucketReceiver) as unknown;
            },
          });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as unknown as Bindings;

    await expect(reconcileStorage(stuckEnv, now)).rejects.toThrow(
      /R2 reconciliation cursor did not advance/u,
    );
  });
});
