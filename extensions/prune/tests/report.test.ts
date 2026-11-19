import { describe, expect, it } from "vitest";
import { bytesText, removedText } from "../ui/prune-report.ts";

describe("bytesText", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1.0 kB"],
    [999_950, "1.0 MB"],
    [12_400_000, "12.4 MB"],
    [1.5e12, "1.5 TB"],
  ])("formats %d as %s", (bytes, text) => {
    expect(bytesText(bytes)).toBe(text);
  });
});

describe("removedText", () => {
  it("adds the freed bytes", () => {
    expect(removedText({ sessions: 2, runs: 1, handoffs: 0, bytes: 12_400_000 }, 30)).toBe(
      "pi-prune: removed 2 sessions, 1 agent run older than 30 days, 12.4 MB freed",
    );
  });

  it("leaves out freed bytes when none", () => {
    expect(removedText({ sessions: 0, runs: 0, handoffs: 1, bytes: 0 }, 30)).toBe(
      "pi-prune: removed 1 handoff dir older than 30 days",
    );
  });
});
