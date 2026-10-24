import { describe, expect, it } from "vitest";
import { mergeChanges } from "../../../core/agent-setup/write.ts";

describe("agent setup write", () => {
  it("merges changes field by field into existing agent entries", () => {
    expect(
      mergeChanges({ other: true, agents: { scout: { model: "fake/model", thinking: "low" } } }, [
        { name: "scout", patch: { thinking: "high" } },
      ]),
    ).toEqual({ other: true, agents: { scout: { model: "fake/model", thinking: "high" } } });
  });

  it("refuses an agents key that is not an object", () => {
    const change = { name: "scout", patch: { thinking: "high" } };

    expect(() => mergeChanges({ agents: [] }, [change])).toThrow('"agents" is not an object');
  });
});
