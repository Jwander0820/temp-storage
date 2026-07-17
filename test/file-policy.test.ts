import { describe, expect, it } from "vitest";
import { classifyFile } from "../src/services/file-type-service";

const encoder = new TextEncoder();

describe("file policy", () => {
  it("allows a real JPEG preview", () => {
    expect(classifyFile(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "jpg", "image/jpeg")).toEqual({
      detectedMime: "image/jpeg",
      previewPolicy: "inline",
    });
  });

  it("blocks HTML disguised as a JPEG", () => {
    expect(
      classifyFile(encoder.encode("<!doctype html><script>alert(1)</script>"), "jpg", "image/jpeg"),
    ).toMatchObject({ previewPolicy: "blocked" });
  });

  it("keeps PDF and ZIP download-only", () => {
    expect(classifyFile(encoder.encode("%PDF-1.7"), "pdf", "application/pdf")).toMatchObject({
      detectedMime: "application/pdf",
      previewPolicy: "download_only",
    });
    expect(
      classifyFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "zip", "application/zip"),
    ).toMatchObject({
      detectedMime: "application/zip",
      previewPolicy: "download_only",
    });
  });

  it("distinguishes AVIF from MP4 brands", () => {
    const avif = encoder.encode("\0\0\0\u0018ftypavif\0\0\0\0avif");
    const mp4 = encoder.encode("\0\0\0\u0018ftypisom\0\0\0\0mp42");
    expect(classifyFile(avif, "avif", "image/avif").detectedMime).toBe("image/avif");
    expect(classifyFile(mp4, "mp4", "video/mp4").detectedMime).toBe("video/mp4");
  });
});
