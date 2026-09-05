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

  it("accepts official dummy responses when the dummy secret is restricted to a local origin", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(Response.json({ success: true, hostname: "example.com", action: null })),
    );
    const officialTestBindings = {
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      UPLOAD_ORIGIN: "http://localhost:8976",
    };

    await expect(
      verifyTurnstile(officialTestBindings, "dummy-token", "127.0.0.1", undefined, "admin"),
    ).resolves.toBeUndefined();

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

  it.each(["https://upload.example.test", "https://upload.jwander.net"])(
    "rejects local test mode for non-local upload origin %s",
    async (uploadOrigin) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(
        verifyTurnstile(
          {
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            UPLOAD_ORIGIN: uploadOrigin,
          },
          "dummy-token",
          "127.0.0.1",
        ),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
