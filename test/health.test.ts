import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("health endpoint", () => {
  it("returns the service status", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/api/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
