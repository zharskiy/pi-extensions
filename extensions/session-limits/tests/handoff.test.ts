import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { handoffInstruction } from "../../../platform/shared/index.ts";
import { handoffPath, MAIN_AUDIENCE, sessionPreface, validateMainHandoff } from "../core/handoff.ts";

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
      join(tmpdir(), "pi-handoff", "s1", "main-handoff.md"),
    );
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

describe("main handoff instruction", () => {
  const text = handoffInstruction({ path: "/tmp/h.md", reason: "Full.", audience: MAIN_AUDIENCE });

  it("offers done for the user's goal and adds the background-work and skills rules", () => {
    expect(text).toContain("for the user's current goal: done, partial or blocked");
    expect(text).toContain("the switch to the new session waits for it");
    expect(text).toContain("`Skills: <names>`");
  });
});

describe("sessionPreface", () => {
  it("names the previous session file or says the previous session", () => {
    expect(sessionPreface({ file: "/sessions/main.jsonl", manual: false })).toContain(
      "the previous session /sessions/main.jsonl, which reached its context limit",
    );
    expect(sessionPreface({ manual: false })).toContain("continues the previous session, which");
  });

  it("names /session-handoff and repeats the focus only for a manual handoff", () => {
    const manual = sessionPreface({ manual: true, focus: "ship the release" });

    expect(manual).toContain("which the user handed off with /session-handoff");
    expect(manual).toContain("The user said this session is for: ship the release.");
    expect(sessionPreface({ manual: true })).not.toContain("this session is for");
    expect(sessionPreface({ manual: false, focus: "x" })).not.toContain("this session is for");
  });

  it("ends the first paragraph with the Next-section sentence", () => {
    const first = sessionPreface({ manual: false }).split("\n")[0];

    expect(first.endsWith("Continue from its Next section without asking the user to repeat.")).toBe(true);
  });
});
