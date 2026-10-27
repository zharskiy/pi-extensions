import { describe, expect, it } from "vitest";
import { handoffStep, shouldRequest } from "../core/thresholds.ts";
import { segmentFor } from "../ui/threshold-text.ts";

const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

const at = (tokens: number | null, window = 100_000) => ({ tokens, window });

const VALID = { ok: true, status: "partial" } as const;

type HandoffInput = Parameters<typeof handoffStep>[0];

const input = (patch: Partial<HandoffInput>): HandoffInput => ({
  phase: "requested",
  saved: undefined,
  busy: false,
  settled: true,
  instructions: 1,
  ...patch,
});

describe("shouldRequest", () => {
  it("requests only once, from the watching phase at the hard level", () => {
    expect(shouldRequest("watching", "hard")).toBe(true);
    expect(shouldRequest("watching", "soft")).toBe(false);
    expect(shouldRequest("requested", "hard")).toBe(false);
    expect(shouldRequest("stuck", "hard")).toBe(false);
  });
});

describe("handoffStep", () => {
  it("does nothing outside a pending request", () => {
    expect(handoffStep(input({ phase: "watching", saved: VALID }))).toBe("none");
    expect(handoffStep(input({ phase: "switching", saved: VALID }))).toBe("none");
    expect(handoffStep(input({ phase: "stuck" }))).toBe("none");
  });

  it("switches on a valid file and waits while work is reported running", () => {
    expect(handoffStep(input({ saved: VALID }))).toBe("switch");
    expect(handoffStep(input({ saved: VALID, busy: true }))).toBe("wait");
    expect(handoffStep(input({ phase: "waiting", saved: VALID }))).toBe("switch");
    expect(handoffStep(input({ saved: VALID, settled: false }))).toBe("switch");
  });

  it("judges a missing or invalid file only after the session settles", () => {
    expect(handoffStep(input({ settled: false }))).toBe("none");
    expect(handoffStep(input({}))).toBe("resend");
    expect(handoffStep(input({ saved: { ok: false, errors: ["x"] } }))).toBe("resend");
    expect(handoffStep(input({ instructions: 2 }))).toBe("give-up");
  });
});

describe("segmentFor", () => {
  it("names the hard threshold and the tokens used when the token cap wins", () => {
    expect(segmentFor(at(160_000, 1_000_000), false, limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» handoff at 175k tokens · 160.0k used",
    });
  });

  it("names the hard threshold when the ratio wins", () => {
    expect(segmentFor(at(100_000, 200_000), false, limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» handoff at 120k tokens · 100.0k used",
    });
    expect(
      segmentFor(
        at(142_300, 200_000),
        false,
        { ...limits, hardTokens: 175_000, hardRatio: 0.9 },
        "session-handoff",
      ),
    ).toEqual({
      token: "warning",
      text: "» handoff at 175k tokens · 142.3k used",
    });
  });

  it("is empty without a known window", () => {
    expect(segmentFor(at(80_000, 0), false, limits, "session-handoff")).toBeUndefined();
  });

  it("is empty below the soft limit and warns from it", () => {
    expect(segmentFor(at(40_000), false, limits, "session-handoff")).toBeUndefined();
    expect(segmentFor(at(50_000), false, limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» handoff at 60k tokens · 50.0k used",
    });
  });

  it("keeps the threshold warning while a handoff is in progress and says nothing else", () => {
    expect(segmentFor(at(78_000), false, limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» handoff at 60k tokens · 78.0k used",
    });
    expect(segmentFor(at(40_000), false, limits, "session-handoff")).toBeUndefined();
    expect(segmentFor(undefined, false, limits, "session-handoff")).toBeUndefined();
  });

  it("marks only the failure with the error glyph and colour, and names the command", () => {
    expect(segmentFor(at(78_000), true, limits, "session-handoff")).toEqual({
      token: "error",
      text: "✗ handoff failed · run /session-handoff",
    });
  });

  it("never repeats the footer's context percentage", () => {
    [false, true].forEach((stuck) => {
      expect(segmentFor(at(78_000), stuck, limits, "session-handoff")?.text).not.toMatch(/ctx|%/);
    });
  });
});
