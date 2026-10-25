import { describe, expect, it } from "vitest";
import { contextLevel, handoffStep, retryInstruction, shouldRequest } from "../core/thresholds.ts";
import { segmentFor } from "../ui/threshold-text.ts";

const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

const at = (tokens: number | null, window = 100_000) => ({ tokens, window });

type HandoffInput = Parameters<typeof handoffStep>[0];

const input = (patch: Partial<HandoffInput>): HandoffInput => ({
  phase: "requested",
  file: { kind: "missing" },
  busy: false,
  settled: true,
  instructions: 1,
  ...patch,
});

describe("contextLevel", () => {
  it("classifies tokens against the soft and hard ratios of a small window", () => {
    expect(contextLevel(at(44_999), limits)).toBe("normal");
    expect(contextLevel(at(45_000), limits)).toBe("soft");
    expect(contextLevel(at(59_999), limits)).toBe("soft");
    expect(contextLevel(at(60_000), limits)).toBe("hard");
  });

  it("caps the thresholds by tokens on a large window", () => {
    const large = (tokens: number) => at(tokens, 1_000_000);

    expect(contextLevel(large(124_999), limits)).toBe("normal");
    expect(contextLevel(large(125_000), limits)).toBe("soft");
    expect(contextLevel(large(174_999), limits)).toBe("soft");
    expect(contextLevel(large(175_000), limits)).toBe("hard");
  });

  it("keeps the ratios when they are below the caps", () => {
    const medium = (tokens: number) => at(tokens, 200_000);

    expect(contextLevel(medium(89_999), limits)).toBe("normal");
    expect(contextLevel(medium(90_000), limits)).toBe("soft");
    expect(contextLevel(medium(120_000), limits)).toBe("hard");
  });

  it("is unknown without tokens or window", () => {
    expect(contextLevel(at(null), limits)).toBe("unknown");
    expect(contextLevel(at(80_000, 0), limits)).toBe("unknown");
    expect(contextLevel(at(null, 1_000_000), limits)).toBe("unknown");
  });

  it("skips the soft stage when the soft threshold is above the hard one", () => {
    const inverted = { ...limits, softRatio: 0.9, hardRatio: 0.75 };

    expect(contextLevel(at(80_000), inverted)).toBe("hard");
    expect(contextLevel(at(70_000), inverted)).toBe("normal");
    expect(contextLevel(at(170_000, 1_000_000), { ...limits, softTokens: 250_000 })).toBe("normal");
  });
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
    expect(handoffStep(input({ phase: "watching", file: { kind: "valid" } }))).toBe("none");
    expect(handoffStep(input({ phase: "switching", file: { kind: "valid" } }))).toBe("none");
    expect(handoffStep(input({ phase: "stuck" }))).toBe("none");
  });

  it("switches on a valid file and waits while work is reported running", () => {
    expect(handoffStep(input({ file: { kind: "valid" } }))).toBe("switch");
    expect(handoffStep(input({ file: { kind: "valid" }, busy: true }))).toBe("wait");
    expect(handoffStep(input({ phase: "waiting", file: { kind: "valid" } }))).toBe("switch");
    expect(handoffStep(input({ file: { kind: "valid" }, settled: false }))).toBe("switch");
  });

  it("judges a missing or invalid file only after the session settles", () => {
    expect(handoffStep(input({ settled: false }))).toBe("none");
    expect(handoffStep(input({}))).toBe("resend");
    expect(handoffStep(input({ file: { kind: "invalid", errors: ["x"] } }))).toBe("resend");
    expect(handoffStep(input({ instructions: 2 }))).toBe("give-up");
  });
});

describe("segmentFor", () => {
  it("names the hard threshold and the tokens used when the token cap wins", () => {
    expect(segmentFor(at(160_000, 1_000_000), "watching", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» Handoff at 175k tokens · 160.0k used",
    });
  });

  it("names the hard threshold when the ratio wins", () => {
    expect(segmentFor(at(100_000, 200_000), "watching", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» Handoff at 120k tokens · 100.0k used",
    });
    expect(
      segmentFor(
        at(142_300, 200_000),
        "watching",
        { ...limits, hardTokens: 175_000, hardRatio: 0.9 },
        "session-handoff",
      ),
    ).toEqual({
      token: "warning",
      text: "» Handoff at 175k tokens · 142.3k used",
    });
  });

  it("is empty below the soft limit and warns from it", () => {
    expect(segmentFor(at(40_000), "watching", limits, "session-handoff")).toBeUndefined();
    expect(segmentFor(at(50_000), "watching", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "» Handoff at 60k tokens · 50.0k used",
    });
  });

  it("uses one sentence pattern in warning for every phase in progress", () => {
    const text = (phase: "queued" | "requested" | "waiting" | "switching") =>
      segmentFor(at(78_000), phase, limits, "session-handoff");

    expect(text("queued")).toEqual({ token: "warning", text: "» Handoff after this turn" });
    expect(text("waiting")).toEqual({ token: "warning", text: "» Handoff waiting for running work" });
    expect(text("requested")).toEqual({ token: "warning", text: "» Handoff writing the document" });
    expect(text("switching")).toEqual({ token: "warning", text: "» Handoff switching to a new session" });
    expect(segmentFor(undefined, "requested", limits, "session-handoff")?.text).toBe(
      "» Handoff writing the document",
    );
    expect(segmentFor(undefined, "watching", limits, "session-handoff")).toBeUndefined();
  });

  it("marks only the failure with the error glyph and colour, and names the command", () => {
    expect(segmentFor(at(78_000), "stuck", limits, "session-handoff")).toEqual({
      token: "error",
      text: "✗ Handoff failed · run /session-handoff",
    });
  });

  it("never repeats the footer's context percentage", () => {
    const phases = ["watching", "queued", "requested", "waiting", "switching", "stuck"] as const;

    phases.forEach((phase) => {
      expect(segmentFor(at(78_000), phase, limits, "session-handoff")?.text).not.toMatch(/ctx|%/);
    });
  });
});

describe("retryInstruction", () => {
  it("appends the validation errors to the instruction", () => {
    const text = retryInstruction("write it", ["missing sections: Next"]);

    expect(text.startsWith("write it")).toBe(true);
    expect(text).toContain("- missing sections: Next");
  });
});
