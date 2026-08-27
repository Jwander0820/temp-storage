import { describe, expect, it } from "vitest";
import { createDefaultInvitationLabel } from "../public/invitation-label";

describe("default invitation labels", () => {
  it("includes the local calendar date and time for upload invitations", () => {
    const date = new Date(2026, 7, 27, 9, 5, 7);

    expect(createDefaultInvitationLabel("upload", date)).toBe("upload-20260827-090507");
  });

  it("uses a distinct prefix for browse-only invitations", () => {
    const date = new Date(2026, 7, 27, 21, 42, 3);

    expect(createDefaultInvitationLabel("browse", date)).toBe("browse-20260827-214203");
  });
});
