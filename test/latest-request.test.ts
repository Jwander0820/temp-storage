import { describe, expect, it } from "vitest";
import { createLatestRequestCoordinator } from "../public/latest-request";

describe("latest request coordinator", () => {
  it("aborts the previous request and only keeps the latest request current", () => {
    const coordinator = createLatestRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);

    second.finish();
    expect(second.isCurrent()).toBe(true);
  });
});
