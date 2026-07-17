import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { reserveQuotaAndCreateRecords } from "../src/repositories/quota-repository";
import { createTestInvitation, resetState, TEST_INVITATION_ID } from "./helpers";

function reservation(sizeBytes: number, suffix: string) {
  const now = 1_800_000_000;
  return {
    eventId: `event-${suffix}`,
    reservationId: `reservation-${suffix}`,
    fileId: `file-${suffix}`,
    objectKey: `objects/2027/01/15/file-${suffix}`,
    filename: `file-${suffix}.bin`,
    extension: "bin",
    declaredMime: "application/octet-stream",
    sizeBytes,
    uploaderHash: `uploader-${suffix}`,
    previousUploaderHash: `previous-${suffix}`,
    invitationId: TEST_INVITATION_ID,
    createdAt: now,
    reservationExpiresAt: now + 900,
    fileExpiresAt: now + 2_592_000,
  };
}

describe("quota reservation", () => {
  beforeEach(async () => {
    await resetState(100);
    await createTestInvitation({ now: 1_800_000_000, maxBytes: 1000 });
  });

  it("allows an exact-capacity reservation", async () => {
    await reserveQuotaAndCreateRecords(env.DB, reservation(100, "exact"));

    const usage = await env.DB.prepare(
      "SELECT used_bytes, reserved_bytes FROM storage_usage WHERE id = 1",
    ).first<{ used_bytes: number; reserved_bytes: number }>();
    expect(usage).toEqual({ used_bytes: 0, reserved_bytes: 100 });
  });

  it("rejects a reservation that is one byte over capacity", async () => {
    await expect(
      reserveQuotaAndCreateRecords(env.DB, reservation(101, "over")),
    ).rejects.toMatchObject({
      code: "STORAGE_LIMIT_EXCEEDED",
      status: 507,
    });
  });

  it("serializes concurrent reservations without exceeding capacity", async () => {
    const results = await Promise.allSettled([
      reserveQuotaAndCreateRecords(env.DB, reservation(60, "a")),
      reserveQuotaAndCreateRecords(env.DB, reservation(60, "b")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const usage = await env.DB.prepare(
      "SELECT reserved_bytes FROM storage_usage WHERE id = 1",
    ).first<{ reserved_bytes: number }>();
    expect(usage?.reserved_bytes).toBe(60);
  });
});
