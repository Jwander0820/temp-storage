import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { reserveQuotaAndCreateRecords } from "../src/repositories/quota-repository";
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
        objectKey: "objects/2027/01/15/expired-file",
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
        objectKey: "objects/2027/01/15/active-file",
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
    await env.FILES.put("objects/2027/01/15/active-file", new Uint8Array([1, 2, 3, 4]));
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
    expect(await env.FILES.head("objects/2027/01/15/active-file")).toBeNull();

    const usage = await env.DB.prepare("SELECT used_bytes FROM storage_usage WHERE id = 1").first<{
      used_bytes: number;
    }>();
    expect(usage?.used_bytes).toBe(0);
  });
});
