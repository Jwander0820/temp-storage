import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyOptionalAccessCode, verifyTurnstile } from "../src/services/turnstile-service";

describe("Turnstile and optional access code", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only the configured Turnstile hostname and invitation action", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        hostname: "upload.example.test",
        action: "invite",
      }),
    );
    await expect(
      verifyTurnstile(
        {
          TURNSTILE_SECRET_KEY: "secret",
          UPLOAD_ORIGIN: "https://upload.example.test",
        },
        "token",
        "203.0.113.10",
      ),
    ).resolves.toBeUndefined();

    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        success: true,
        hostname: "cdn.example.test",
        action: "invite",
      }),
    );
    await expect(
      verifyTurnstile(
        {
          TURNSTILE_SECRET_KEY: "secret",
          UPLOAD_ORIGIN: "https://upload.example.test",
        },
        "token",
        "203.0.113.10",
      ),
    ).rejects.toMatchObject({ code: "TURNSTILE_FAILED", status: 403 });
  });

  it("keeps UPLOAD_ACCESS_CODE as an optional second gate", async () => {
    await expect(
      verifyOptionalAccessCode({ UPLOAD_ACCESS_CODE: "second-secret" }, "second-secret"),
    ).resolves.toBeUndefined();
    await expect(
      verifyOptionalAccessCode({ UPLOAD_ACCESS_CODE: "second-secret" }, "wrong"),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID", status: 403 });
    await expect(
      verifyOptionalAccessCode({ UPLOAD_ACCESS_CODE: "" }, null),
    ).resolves.toBeUndefined();
  });

  it("accepts official dummy responses only when explicit local test mode is enabled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(Response.json({ success: true, hostname: "example.com", action: null })),
    );
    const officialTestBindings = {
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_TEST_MODE: "true",
      UPLOAD_ORIGIN: "http://localhost:8976",
    };

    await expect(
      verifyTurnstile(officialTestBindings, "dummy-token", "127.0.0.1", undefined, "admin"),
    ).resolves.toBeUndefined();

    await expect(
      verifyTurnstile(
        { ...officialTestBindings, TURNSTILE_TEST_MODE: "false" },
        "dummy-token",
        "127.0.0.1",
        undefined,
        "admin",
      ),
    ).rejects.toMatchObject({ code: "TURNSTILE_FAILED", status: 403 });

    await expect(
      verifyTurnstile(
        { ...officialTestBindings, TURNSTILE_SECRET_KEY: "production-secret" },
        "dummy-token",
        "127.0.0.1",
        undefined,
        "admin",
      ),
    ).rejects.toMatchObject({ code: "TURNSTILE_FAILED", status: 403 });
  });
});
