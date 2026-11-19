import { describe, expect, it } from "vitest";
import { bytesText, confirmText, outcomeText, removedText, rowText } from "../ui/prune-report.ts";

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

const MANY = { sessions: 12_345, runs: 1_000, handoffs: 211_941, bytes: 0 };

describe("counts", () => {
  it("groups thousands in every text", () => {
    expect(rowText(MANY)).toBe("12,345 sessions, 1,000 agent runs, 211,941 handoff dirs");
    expect(confirmText(MANY, 1_095)).toMatch(
      /^Remove 12,345 sessions, 1,000 agent runs, 211,941 handoff dirs not touched for 1,095 days\? /,
    );
    expect(removedText(MANY, 30, 4_200)).toBe(
      "pi-prune: removed 12,345 sessions, 1,000 agent runs, 211,941 handoff dirs older than 30 days, 4,200 empty handoff dirs",
    );
  });
});

describe("outcomeText", () => {
  const expected = { sessions: 3, runs: 0, handoffs: 1, bytes: 0 };

  it.each([
    [
      { sessions: 3, runs: 0, handoffs: 1, bytes: 0 },
      "pi-prune: removed 3 sessions, 1 handoff dir older than 60 days",
    ],
    [
      { sessions: 1, runs: 0, handoffs: 0, bytes: 0 },
      "pi-prune: removed 1 session older than 60 days, the rest changed since the scan and was kept",
    ],
    [
      { sessions: 0, runs: 0, handoffs: 0, bytes: 0 },
      "pi-prune: nothing removed, the sessions changed since the scan",
    ],
  ])("tells %o as %s", (removed, text) => {
    expect(outcomeText(removed, expected, 60)).toBe(text);
  });
});
