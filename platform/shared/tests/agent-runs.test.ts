import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRules, sessionRunsDir, sessionStem } from "../agent-runs/agent-runs.ts";

describe("agent run layout", () => {
  it("puts a session's runs beside its file, or under the fallback root without one", () => {
    expect(sessionStem(join("/s", "a.jsonl"))).toBe(join("/s", "a"));
    expect(sessionRunsDir({ agentDir: "/agent", id: "a", file: join("/s", "a.jsonl") })).toBe(
      join("/s", "a", "agents"),
    );
    expect(sessionRunsDir({ agentDir: "/agent", id: "a" })).toBe(
      join("/agent", "pi-subagents", "a", "agents"),
    );
  });
});

describe("runRules", () => {
  it.each([
    [
      { predecessorId: "p", successorId: "s" },
      { links: ["p", "s"], keep: false },
    ],
    [
      { predecessorId: 7, worktree: { cleanup: "removed" } },
      { links: [], keep: false },
    ],
    [{ worktree: { path: "/w" } }, { links: [], keep: true }],
    [{ worktree: { cleanup: "branch kept" } }, { links: [], keep: true }],
    [{ worktree: { cleanup: "kept" } }, { links: [], keep: true }],
    [null, { links: [], keep: false }],
    ["text", { links: [], keep: false }],
  ])("reads %j as %j", (manifest, rules) => {
    expect(runRules(manifest)).toEqual(rules);
  });
});
