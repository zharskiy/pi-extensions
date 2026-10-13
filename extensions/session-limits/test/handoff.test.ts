import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../core/adapter/contract.ts";
import { handoffPath, seedText, validateMainHandoff } from "../src/handoff.ts";

const info = (patch: Partial<SessionInfo>): SessionInfo => ({
  id: "s1",
  cwd: "/project",
  agentDir: "/agent",
  projectTrusted: false,
  subscription: false,
  mode: "tui",
  ...patch,
});

const handoff = (sections: Record<string, string>) =>
  Object.entries(sections)
    .map(([title, body]) => `## ${title}\n${body}\n`)
    .join("\n");

const complete = {
  Status: "partial",
  Outcome: "- goal",
  Evidence: "- tests pass",
  Blocker: "none",
  Next: "- continue",
  "Files touched": "none",
};

describe("handoffPath", () => {
  it("sits under the OS temp dir, named after the session id", () => {
    expect(handoffPath(info({ file: "/sessions/main.jsonl" }))).toBe(
      join(tmpdir(), "pi-session-limits", "s1-handoff.md"),
    );
  });
});

describe("seedText", () => {
  it("names the previous session and carries the handoff", () => {
    const text = seedText("/sessions/main.jsonl", "## Status\npartial\n");

    expect(text).toContain("the previous session /sessions/main.jsonl");
    expect(text.endsWith("## Status\npartial")).toBe(true);
    expect(seedText(undefined, "x")).toContain("continues the previous session, which");
  });
});

describe("validateMainHandoff", () => {
  it("accepts done, partial and blocked", () => {
    expect(validateMainHandoff(handoff(complete))).toEqual({ ok: true, status: "partial" });
    expect(validateMainHandoff(handoff({ ...complete, Status: "**Done**" }))).toEqual({
      ok: true,
      status: "done",
    });
  });

  it("rejects an unknown status", () => {
    expect(validateMainHandoff(handoff({ ...complete, Status: "almost" }))).toEqual({
      ok: false,
      errors: ["Status must be one of done, partial, blocked"],
    });
  });
});
