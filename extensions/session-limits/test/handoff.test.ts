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
  it("sits in the folder named after the session file", () => {
    expect(handoffPath(info({ file: "/sessions/main.jsonl" }))).toBe("/sessions/main/main-handoff.md");
  });

  it("falls back to pi's agent dir without a session file", () => {
    expect(handoffPath(info({}))).toBe("/agent/pi-session-limits/s1/main-handoff.md");
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
