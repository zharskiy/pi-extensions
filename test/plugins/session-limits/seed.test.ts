import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../src/adapter/contract.ts";
import type { AgentRecord } from "../../../src/manager/types.ts";
import { mainHandoffPath, seedText } from "../../../src/plugins/session-limits/seed.ts";

const info = (patch: Partial<SessionInfo>): SessionInfo => ({
  id: "s1",
  dir: "/sessions",
  cwd: "/project",
  agentDir: "/agent",
  projectTrusted: false,
  hasUI: true,
  subscription: false,
  ...patch,
});

describe("mainHandoffPath", () => {
  it("sits next to the agents dir of the session", () => {
    expect(mainHandoffPath(info({ file: "/sessions/main.jsonl" }))).toBe("/sessions/main/main-handoff.md");
  });

  it("falls back to the tmp dir without a session file", () => {
    expect(mainHandoffPath(info({}))).toBe(join(tmpdir(), "pi-subagents", "s1", "main-handoff.md"));
    expect(mainHandoffPath(undefined)).toBe(join(tmpdir(), "pi-subagents", "no-session", "main-handoff.md"));
  });
});

describe("seedText", () => {
  it("names the previous session and carries the handoff", () => {
    const text = seedText("/sessions/main.jsonl", "## Status\npartial\n", []);

    expect(text).toContain("the previous session /sessions/main.jsonl");
    expect(text).toContain("## Status\npartial");
    expect(text).not.toContain("finished after");
  });

  it("lists agents that finished after the handoff was written", () => {
    const record = {
      id: "explorer-1a2b",
      agent: "explorer",
      state: "done",
      resultPath: "/r.md",
    } as AgentRecord;

    const text = seedText(undefined, "handoff", [record]);

    expect(text).toContain("- explorer-1a2b (explorer): done, result: /r.md");
  });
});
