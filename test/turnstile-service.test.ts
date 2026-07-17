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
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 403 });
    await expect(
      verifyOptionalAccessCode({ UPLOAD_ACCESS_CODE: "" }, null),
    ).resolves.toBeUndefined();
  });
});
