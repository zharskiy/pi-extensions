import { describe, expect, it } from "vitest";
import { formatDuration } from "../../manager/format.ts";

describe("formatDuration", () => {
  it("formats durations like the shared formatter", () => {
    expect(formatDuration(3_000)).toBe("3s");
    expect(formatDuration(75_000)).toBe("1m 15s");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });
});
