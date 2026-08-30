import { describe, expect, it } from "vitest";
import { validatePublicFileUrls } from "../public/public-file-url";

const policy = {
  uploadOrigin: "https://upload.example.test",
  cdnOrigin: "https://cdn.example.test",
};

describe("public file URL validation", () => {
  it("accepts the configured download route and temp-storage CDN prefix", () => {
    expect(
      validatePublicFileUrls({
        ...policy,
        id: "abc_123-xyz",
        previewPolicy: "inline",
        previewUrl: "https://cdn.example.test/temp-storage/objects/2026/08/30/abc_123-xyz",
        downloadUrl: "https://upload.example.test/d/abc_123-xyz",
      }),
    ).toEqual({
      previewUrl: "https://cdn.example.test/temp-storage/objects/2026/08/30/abc_123-xyz",
      downloadUrl: "https://upload.example.test/d/abc_123-xyz",
    });
  });

  it.each([
    "javascript:alert(1)",
    "https://evil.example/d/abc_123-xyz",
    "https://upload.example.test/d/other-id",
    "https://upload.example.test/d/abc_123-xyz?download=1",
  ])("rejects an untrusted download URL %s", (downloadUrl) => {
    expect(() =>
      validatePublicFileUrls({
        ...policy,
        id: "abc_123-xyz",
        previewPolicy: "download_only",
        previewUrl: null,
        downloadUrl,
      }),
    ).toThrow(/download URL/u);
  });

  it.each([
    "javascript:alert(1)",
    "https://evil.example/temp-storage/objects/file",
    "https://cdn.example.test/other-prefix/file",
    "https://cdn.example.test/temp-storage/objects/file?variant=1",
  ])("rejects an untrusted preview URL %s", (previewUrl) => {
    expect(() =>
      validatePublicFileUrls({
        ...policy,
        id: "abc_123-xyz",
        previewPolicy: "inline",
        previewUrl,
        downloadUrl: "https://upload.example.test/d/abc_123-xyz",
      }),
    ).toThrow(/preview URL/u);
  });

  it("requires inline previews and forbids previews for download-only files", () => {
    expect(() =>
      validatePublicFileUrls({
        ...policy,
        id: "abc_123-xyz",
        previewPolicy: "inline",
        previewUrl: null,
        downloadUrl: "https://upload.example.test/d/abc_123-xyz",
      }),
    ).toThrow(/preview URL/u);
    expect(() =>
      validatePublicFileUrls({
        ...policy,
        id: "abc_123-xyz",
        previewPolicy: "download_only",
        previewUrl: "https://cdn.example.test/temp-storage/objects/file",
        downloadUrl: "https://upload.example.test/d/abc_123-xyz",
      }),
    ).toThrow(/preview URL/u);
  });
});
