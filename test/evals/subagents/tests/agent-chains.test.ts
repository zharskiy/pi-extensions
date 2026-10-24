import { describe, expect, it } from "vitest";
import { failureReason, failureSuffix, helperLine, taskLine } from "../support/agent-chains.ts";

describe("failureReason", () => {
  it("takes the first non-empty line of the error, cut to 160 chars", () => {
    expect(failureReason({ error: "\n quota reached \nstack" })).toBe("quota reached");
    expect(failureReason({ error: "x".repeat(200) })).toBe("x".repeat(160));
  });

  it("is absent without an error and adds nothing to the log line", () => {
    expect(failureReason({})).toBeUndefined();
    expect(failureReason(undefined)).toBeUndefined();
    expect(failureSuffix(undefined)).toBe("");
    expect(failureSuffix("quota reached")).toBe(" (failed: quota reached)");
  });
});

describe("taskLine", () => {
  it("skips the runner's header lines and returns the brief's first line", () => {
    const prompt = [
      "Task from agent-1 (agent id agent-2):",
      "Agent folder: /tmp/agents/agent-2",
      "",
      "Goal: find every caller of record().",
      "Known: nothing yet.",
    ].join("\n");

    expect(taskLine(prompt)).toBe("Goal: find every caller of record().");
  });

  it("cuts the line to 140 characters", () => {
    expect(taskLine(`Goal: ${"x".repeat(200)}`)).toHaveLength(140);
  });

  it("returns an empty line for an empty prompt", () => {
    expect(taskLine("Task from main (agent id a1):\n\n")).toBe("");
  });
});

describe("helperLine", () => {
  it("names the helper's kind and state before its task", () => {
    expect(helperLine("scout", "done", "Goal: x")).toBe("    helper scout done: Goal: x");
  });

  it("adds the reason a helper failed", () => {
    expect(helperLine("scout", "failed", "Goal: x", "aborted")).toBe(
      "    helper scout failed: Goal: x (failed: aborted)",
    );
  });
});
