import { describe, expect, it } from "vitest";
import {
  createDeleteCapabilityExport,
  createDeleteUrl,
  deleteTokenFromFragment,
  validateDeleteUrl,
} from "../public/delete-capability";

const fileId = "A".repeat(22);
const token = "B".repeat(43);
const origin = "https://upload.example.test";

describe("delete capability URLs", () => {
  it("keeps the token in the fragment so it is not sent by the initial GET", () => {
    const url = createDeleteUrl(origin, fileId, token);

    expect(url).toBe(`${origin}/delete/${fileId}#token=${token}`);
    expect(deleteTokenFromFragment(new URL(url).hash)).toBe(token);
    expect(new URL(url).search).toBe("");
  });

  it("rejects malformed or substituted capabilities", () => {
    expect(deleteTokenFromFragment("#token=short")).toBeNull();
    expect(() => createDeleteUrl(origin, "short", token)).toThrow(/capability/u);
    expect(() =>
      validateDeleteUrl(
        `https://evil.example/delete/${fileId}#token=${token}`,
        origin,
        fileId,
        token,
      ),
    ).toThrow(/delete URL/u);
  });

  it("exports every completed file without allowing filenames to add rows or columns", () => {
    expect(
      createDeleteCapabilityExport([
        {
          fileId,
          deleteToken: token,
          deleteUrl: createDeleteUrl(origin, fileId, token),
          filename: "a\tb.jpg",
        },
        {
          fileId: "C".repeat(22),
          deleteToken: "D".repeat(43),
          deleteUrl: createDeleteUrl(origin, "C".repeat(22), "D".repeat(43)),
          filename: "second\nfile.jpg",
        },
      ]),
    ).toContain(`a b.jpg\t${origin}/delete/${fileId}#token=${token}\r\nsecond file.jpg\t`);
    expect(
      createDeleteCapabilityExport([
        {
          fileId,
          deleteToken: token,
          deleteUrl: createDeleteUrl(origin, fileId, token),
          filename: '=HYPERLINK("https://evil.example")',
        },
      ]),
    ).toContain("'=HYPERLINK");
  });
});
