import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../../core/test/helpers/fakes.ts";
import { agentsDirFor } from "../../src/model/paths.ts";

describe("agentsDirFor", () => {
  it("keeps agents under the session's data dir, or under pi's agent dir without a session file", () => {
    const info = { ...createFakeHost().info, id: "s1", agentDir: "/agent" };

    expect(agentsDirFor({ ...info, file: "/sessions/s1.jsonl" })).toBe("/sessions/s1/agents");
    expect(agentsDirFor({ ...info, file: undefined })).toBe("/agent/pi-subagents/s1/agents");
  });
});
