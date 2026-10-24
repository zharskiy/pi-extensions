import { describe, expect, it } from "vitest";
import { modelForGroup, patchAgentFile, shippedGroup } from "./agent-patch.ts";
import { failureReason, failureSuffix, helperLine, taskLine } from "./live-runs.ts";
import { planFiles, planStatus, relativeTo } from "./plan-rows.ts";

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
  it("forces the live model and limit on a lead and keeps the shipped body", () => {
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

  it("keeps a chore's shipped limit", () => {
    const text = patchAgentFile(SHIPPED.replace("planner", "scout"), {
      name: "scout",
      group: "chores",
      patch: { from: "scout" },
      models,
    });

    expect(text).toBe(
      ["---", "name: scout", "model: live/chore:low", "limit: 120000", "---", "Shipped prompt.", ""].join(
        "\n",
      ),
    );
  });

  it("gives chores the chore model and leads the lead model", () => {
    expect(modelForGroup("chores", models)).toBe("live/chore:low");
    expect(modelForGroup("leads", models)).toBe("live/lead:high");
  });

  it("finds the shipped group and refuses a name under both", () => {
    expect(shippedGroup("scout", (group) => group === "chores")).toBe("chores");
    expect(() => shippedGroup("twin", () => true)).toThrow("both leads and chores");
    expect(() => shippedGroup("nobody", () => false)).toThrow("no shipped agent named nobody");
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

  const paths = (text: string) => planFiles(text).map((file) => file.path);

  it("collects every named file once, without markup or line numbers, and marks new ones", () => {
    expect(planFiles(plan)).toEqual([
      { path: "src/a.ts", isNew: false },
      { path: "src/b.ts", isNew: false },
      { path: "src/new.ts", isNew: true },
    ]);
  });

  it("splits on commas, semicolons and 'and', and strips trailing punctuation", () => {
    expect(paths("- agent: editor; description: x; files: src/a.ts; src/b.ts and src/c.ts.")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("expands brace sets before splitting", () => {
    expect(paths("- agent: editor; description: x; files: src/{limits,settings}.ts, test/x.test.ts")).toEqual(
      ["src/limits.ts", "src/settings.ts", "test/x.test.ts"],
    );
  });

  it("keeps globs as written so the caller can leave them out of the existence check", () => {
    expect(paths("- agent: verifier; description: x; files: test/**/*.test.ts")).toEqual([
      "test/**/*.test.ts",
    ]);
  });

  it("accepts numbered and starred rows", () => {
    const text = [
      "1. agent: editor; description: x; files: src/a.ts",
      "* agent: editor; description: y; files: src/b.ts",
    ];

    expect(paths(text.join("\n"))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("follows a files list that wraps onto the next indented line", () => {
    const text = [
      "- agent: implementer; description: x; files: src/a.ts,",
      "  src/b.ts, src/c.ts",
      "  task: Goal: change things",
    ];

    expect(paths(text.join("\n"))).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("marks entries with a note to create the file as new", () => {
    const text =
      "- agent: implementer; description: x; files: new file src/x.ts, src/y.ts (create), src/z.ts";

    expect(planFiles(text)).toEqual([
      { path: "src/x.ts", isNew: true },
      { path: "src/y.ts", isNew: true },
      { path: "src/z.ts", isNew: false },
    ]);
  });

  it("keeps absolute paths for the caller to make relative", () => {
    expect(paths("- agent: editor; description: x; files: /tmp/project/src/a.ts")).toEqual([
      "/tmp/project/src/a.ts",
    ]);
  });

  it("makes paths under the project relative and leaves the rest alone", () => {
    const roots = ["/var/p", "/private/var/p"];

    expect(relativeTo(roots, "/private/var/p/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo(roots, "/var/p/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo(roots, "/var/pp/src/a.ts")).toBe("/var/pp/src/a.ts");
    expect(relativeTo(roots, "src/a.ts")).toBe("src/a.ts");
  });

  it("reads the status line in plain or emphasised form", () => {
    expect(planStatus(plan)).toBe("done");
    expect(planStatus("**Status:** partial\nmore")).toBe("partial");
    expect(planStatus("no status here")).toBeUndefined();
  });
});

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
