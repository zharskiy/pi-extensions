import { describe, expect, it } from "vitest";
import { contextLevel, handoffStep, retryInstruction, segmentFor, shouldRequest } from "../src/thresholds.ts";

const ratios = { softRatio: 0.6, hardRatio: 0.75 };

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
  it("classifies tokens against the soft and hard ratios of the window", () => {
    expect(contextLevel(at(59_999), ratios)).toBe("normal");
    expect(contextLevel(at(60_000), ratios)).toBe("soft");
    expect(contextLevel(at(74_999), ratios)).toBe("soft");
    expect(contextLevel(at(75_000), ratios)).toBe("hard");
  });

  it("is unknown without tokens or window", () => {
    expect(contextLevel(at(null), ratios)).toBe("unknown");
    expect(contextLevel(at(80_000, 0), ratios)).toBe("unknown");
  });

  it("skips the soft stage when the soft ratio is above the hard ratio", () => {
    expect(contextLevel(at(80_000), { softRatio: 0.9, hardRatio: 0.75 })).toBe("hard");
    expect(contextLevel(at(70_000), { softRatio: 0.9, hardRatio: 0.75 })).toBe("normal");
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
  it("is empty below the soft limit and warns from it", () => {
    expect(segmentFor(at(50_000), "watching", ratios, "session-handoff")).toBeUndefined();
    expect(segmentFor(at(62_000), "watching", ratios, "session-handoff")).toEqual({
      token: "warning",
      text: "ctx 62% · handoff at 75%",
    });
  });

  it("is red in the pending phases, amber while waiting, and names the command when stuck", () => {
    expect(segmentFor(at(78_000), "requested", ratios, "session-handoff")).toEqual({
      token: "error",
      text: "ctx 78% · writing handoff",
    });
    expect(segmentFor(at(78_000), "waiting", ratios, "session-handoff")).toEqual({
      token: "warning",
      text: "ctx 78% · handoff waits for running work",
    });
    expect(segmentFor(at(null), "switching", ratios, "session-handoff")?.text).toBe(
      "ctx · switching session",
    );
    expect(segmentFor(at(78_000), "stuck", ratios, "session-handoff")?.text).toBe(
      "ctx 78% · handoff failed, run /session-handoff",
    );
  });
});

describe("retryInstruction", () => {
  it("appends the validation errors to the instruction", () => {
    const text = retryInstruction("write it", ["missing sections: Next"]);

    expect(text.startsWith("write it")).toBe(true);
    expect(text).toContain("- missing sections: Next");
  });
});
