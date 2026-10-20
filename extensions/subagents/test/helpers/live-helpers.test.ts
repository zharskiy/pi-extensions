import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../../core/test/helpers/fakes.ts";
import { modelForGroup, patchAgentFile, shippedGroup } from "./agent-patch.ts";
import { failureReason, failureSuffix } from "./live-runs.ts";
import { planFiles, planStatus, relativeTo } from "./plan-rows.ts";
import { createTurns } from "./turns.ts";

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

describe("createTurns", () => {
  const deferred = () => {
    const box: { resolve: () => void } = { resolve: () => {} };
    const promise = new Promise<void>((resolve) => {
      box.resolve = resolve;
    });

    return { promise, resolve: () => box.resolve() };
  };

  it("keeps the host busy until the last overlapping run returns and settles once", async () => {
    const host = createFakeHost();
    const settled: number[] = [];

    host.onIdle(() => settled.push(1));

    const turn = createTurns(host);
    const first = deferred();
    const second = deferred();
    const runs = [turn(() => first.promise), turn(() => second.promise)];

    expect(host.idle).toBe(false);

    first.resolve();
    await runs[0];

    expect(host.idle).toBe(false);
    expect(settled).toEqual([]);

    second.resolve();
    await runs[1];

    expect(host.idle).toBe(true);
    expect(settled).toEqual([1]);
  });

  it("goes busy again for a second turn after the first settled and settles again", async () => {
    const host = createFakeHost();
    const settled: number[] = [];

    host.onIdle(() => settled.push(settled.length + 1));

    const turn = createTurns(host);

    await turn(async () => undefined);

    expect(host.idle).toBe(true);
    expect(settled).toEqual([1]);

    const next = deferred();
    const run = turn(() => next.promise);

    expect(host.idle).toBe(false);
    expect(settled).toEqual([1]);

    next.resolve();
    await run;

    expect(host.idle).toBe(true);
    expect(settled).toEqual([1, 2]);
  });

  it("settles and rethrows when the run fails", async () => {
    const host = createFakeHost();
    const turn = createTurns(host);

    await expect(turn(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(host.idle).toBe(true);
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
