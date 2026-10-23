import { describe, expect, it } from "vitest";
import {
  contextLevel,
  handoffStep,
  retryInstruction,
  segmentFor,
  shouldRequest,
  thresholdsFor,
} from "../src/thresholds.ts";

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

    expect(thresholdsFor(1_000_000, limits)).toEqual({ soft: 125_000, hard: 175_000 });
    expect(contextLevel(large(124_999), limits)).toBe("normal");
    expect(contextLevel(large(125_000), limits)).toBe("soft");
    expect(contextLevel(large(174_999), limits)).toBe("soft");
    expect(contextLevel(large(175_000), limits)).toBe("hard");
  });

  it("keeps the ratios when they are below the caps", () => {
    const medium = (tokens: number) => at(tokens, 200_000);

    expect(thresholdsFor(200_000, limits)).toEqual({ soft: 90_000, hard: 120_000 });
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
  it("warns with the token figure of the hard threshold when the token cap wins", () => {
    expect(segmentFor(at(160_000, 1_000_000), "watching", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "Warning: automatic handoff will happen at 175k tokens",
    });
  });

  it("warns with the token figure of the hard threshold when the ratio wins", () => {
    expect(segmentFor(at(100_000, 200_000), "watching", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "Warning: automatic handoff will happen at 120k tokens",
    });
    expect(
      segmentFor(at(100_000, 200_000), "watching", { ...limits, hardTokens: 120_000 }, "session-handoff"),
    ).toEqual({
      token: "warning",
      text: "Warning: automatic handoff will happen at 120k tokens",
    });
  });

  it("is empty below the soft limit and warns from it", () => {
    expect(segmentFor(at(40_000), "watching", limits, "session-handoff")).toBeUndefined();
    expect(segmentFor(at(50_000), "watching", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "Warning: automatic handoff will happen at 60k tokens",
    });
  });

  it("is red in the pending phases, amber while waiting or queued, and names the command when stuck", () => {
    expect(segmentFor(at(78_000), "requested", limits, "session-handoff")).toEqual({
      token: "error",
      text: "Handoff: writing the document",
    });
    expect(segmentFor(at(78_000), "waiting", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "Handoff: waiting for running work",
    });
    expect(segmentFor(at(78_000), "queued", limits, "session-handoff")).toEqual({
      token: "warning",
      text: "Handoff: after this turn",
    });
    expect(segmentFor(at(null), "switching", limits, "session-handoff")?.text).toBe(
      "Handoff: switching session",
    );
    expect(segmentFor(undefined, "requested", limits, "session-handoff")).toEqual({
      token: "error",
      text: "Handoff: writing the document",
    });
    expect(segmentFor(undefined, "watching", limits, "session-handoff")).toBeUndefined();
    expect(segmentFor(at(78_000), "stuck", limits, "session-handoff")?.text).toBe(
      "Handoff failed · run /session-handoff",
    );
  });

  it("never repeats the context figure the footer already shows", () => {
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
