import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../core/adapter/contract.ts";
import { HANDOFF_SECTIONS } from "../../../core/manager/handoff.ts";
import { handoffPath, instructionFor, seedText, validateHandoff } from "../src/handoff.ts";

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

  it("falls back to the tmp dir without a session file", () => {
    expect(handoffPath(info({}))).toBe(join(tmpdir(), "pi-session-limits", "s1", "main-handoff.md"));
    expect(handoffPath(undefined)).toBe(join(tmpdir(), "pi-session-limits", "no-session", "main-handoff.md"));
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

describe("instructionFor", () => {
  it("puts the path into every placeholder of the shipped template", () => {
    const template = readFileSync(resolve(import.meta.dirname, "..", "prompts", "handoff.md"), "utf8");
    const text = instructionFor(template, "/s/main/main-handoff.md");

    expect(text).toContain("/s/main/main-handoff.md");
    expect(text).not.toContain("{{path}}");
    HANDOFF_SECTIONS.forEach((section) => {
      expect(text).toContain(`## ${section}`);
    });
  });
});

describe("validateHandoff", () => {
  it("accepts done, partial and blocked", () => {
    expect(validateHandoff(handoff(complete))).toEqual({ ok: true, status: "partial" });
    expect(validateHandoff(handoff({ ...complete, Status: "**Done**" }))).toEqual({
      ok: true,
      status: "done",
    });
  });

  it("rejects an unknown status", () => {
    expect(validateHandoff(handoff({ ...complete, Status: "almost" }))).toEqual({
      ok: false,
      errors: ["Status must be one of done, partial, blocked"],
    });
  });
});
