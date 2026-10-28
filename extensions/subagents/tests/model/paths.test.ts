import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../../test/framework/index.ts";
import { agentsDirFor, handoffPathFor } from "../../core/model/paths.ts";

describe("agentsDirFor", () => {
  it("keeps agents under the session's data dir, or under pi's agent dir without a session file", () => {
    const info = { ...createFakeHost().info, id: "s1", agentDir: "/agent" };

    expect(agentsDirFor({ ...info, file: "/sessions/s1.jsonl" })).toBe("/sessions/s1/agents");
    expect(agentsDirFor({ ...info, file: undefined })).toBe("/agent/pi-subagents/s1/agents");
  });
});

describe("handoffPathFor", () => {
  it("keeps agent handoffs under the OS temp dir, per session", () => {
    const info = { ...createFakeHost().info, id: "s1" };

    expect(handoffPathFor(info, "worker-1")).toBe(join(tmpdir(), "pi-handoff", "s1", "worker-1-handoff.md"));
  });
});
