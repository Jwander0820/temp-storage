import { describe, expect, it } from "vitest";
import { limitUploadBatch } from "../public/upload-limits";

describe("upload batch limit", () => {
  it("accepts at most ten files from one selection", () => {
    const selected = Array.from({ length: 12 }, (_, index) => `file-${index + 1}`);

    expect(limitUploadBatch(selected, 10)).toEqual({
      files: selected.slice(0, 10),
      omittedCount: 2,
    });
  });

  it("keeps smaller selections unchanged", () => {
    expect(limitUploadBatch(["a", "b"], 10)).toEqual({
      files: ["a", "b"],
      omittedCount: 0,
    });
  });
});
