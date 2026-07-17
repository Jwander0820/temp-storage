import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "../src/utils/range";

describe("range parsing", () => {
  it("supports bounded, open-ended, and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ offset: 0, length: 100 });
    expect(parseRangeHeader("bytes=100-", 1000)).toEqual({ offset: 100, length: 900 });
    expect(parseRangeHeader("bytes=-50", 1000)).toEqual({ offset: 950, length: 50 });
  });

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(() => parseRangeHeader("bytes=1000-", 1000)).toThrow();
    expect(() => parseRangeHeader("bytes=20-10", 1000)).toThrow();
    expect(() => parseRangeHeader("bytes=0-1,4-5", 1000)).toThrow();
  });
});
