import { describe, expect, it } from "vitest";
import { modelForGroup, patchAgentFile } from "./agent-patch.ts";
import { planFiles, planStatus } from "./plan-rows.ts";

const SHIPPED = [
  "---",
  "name: planner",
  "model: a/lead:high",
  "limit: 120000",
  "---",
  "Shipped prompt.",
  "",
].join("\n");

const models = { lead: "live/lead:high", chore: "live/chore:low" };

describe("patchAgentFile", () => {
  it("forces the live model and limit and keeps the shipped body", () => {
    const text = patchAgentFile(SHIPPED, {
      name: "planner",
      group: "leads",
      patch: { from: "planner" },
      models,
    });

    expect(text).toBe(
      ["---", "name: planner", "model: live/lead:high", "limit: 20000", "---", "Shipped prompt.", ""].join(
        "\n",
      ),
    );
  });

  it("lets fields override the limit and a body replace the prompt", () => {
    const text = patchAgentFile(SHIPPED, {
      name: "lead",
      group: "leads",
      patch: { from: "planner", fields: { limit: "120000" }, body: "\nNew prompt.\n\n" },
      models,
    });

    expect(text).toBe(
      ["---", "name: lead", "model: live/lead:high", "limit: 120000", "---", "New prompt.", ""].join("\n"),
    );
  });

  it("gives chores the chore model and leads the lead model", () => {
    expect(modelForGroup("chores", models)).toBe("live/chore:low");
    expect(modelForGroup("leads", models)).toBe("live/lead:high");
  });
});

describe("plan rows", () => {
  const plan = [
    "Status: done",
    "",
    "Approach: change the thresholds.",
    "## Batch 1",
    "- agent: implementer; description: add caps; files: `src/a.ts`, ./src/b.ts:12, src/new.ts (new)",
    "  task: Goal: ... files: not/a/row.ts",
    "- agent: scout; description: find callers; files: none",
    "## Batch 2",
    "- **agent:** verifier; description: run checks; files: src/a.ts",
  ].join("\n");

  it("collects every named file once, without markup, line numbers or notes", () => {
    expect(planFiles(plan)).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);
  });

  it("reads the status line in plain or emphasised form", () => {
    expect(planStatus(plan)).toBe("done");
    expect(planStatus("**Status:** partial\nmore")).toBe("partial");
    expect(planStatus("no status here")).toBeUndefined();
  });
});
