import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDefinitions } from "../../core/agent-definitions/loader.ts";
import {
  type AgentDefinition,
  type AgentRecord,
  chainLinks,
  chainTerminal,
  isLead,
} from "../../core/model/agent-record.ts";
import { agentRecord } from "../support/agent-records.ts";
import { PACKAGE_ROOT, tempDir } from "../support/subagents-harness.ts";

const definition = (patch: Partial<AgentDefinition> & Pick<AgentDefinition, "name">) =>
  ({
    description: `${patch.name} does its job`,
    limit: 100_000,
    tools: ["read", "bash"],
    skills: [],
    subagents: ["scout"],
    prompt: "",
    source: "builtin",
    path: `/pkg/agents/leads/${patch.name}.md`,
    ...patch,
  }) as AgentDefinition;

describe("isLead", () => {
  it("is true for an agent that may start subagents", () => {
    expect(isLead(definition({ name: "reviewer", subagents: ["scout", "shell"] }))).toBe(true);
    expect(isLead(definition({ name: "boss", subagents: "all" }))).toBe(true);
    expect(isLead(definition({ name: "scout", subagents: [] }))).toBe(false);
  });

  it("does not count every skill without subagents as a lead", () => {
    expect(isLead(definition({ name: "solo", skills: "all", subagents: [] }))).toBe(false);
  });

  it("counts the shipped general agent as a lead", () => {
    const loaded = loadDefinitions([{ path: join(PACKAGE_ROOT, "agents"), source: "builtin" }]);
    const general = loaded.definitions.get("general");

    expect(general?.path).toBe(join(PACKAGE_ROOT, "agents", "leads", "general.md"));
    expect(general && isLead(general)).toBe(true);
  });

  it("ignores the folder the agent file sits in", () => {
    const dir = tempDir();
    const file = (name: string, subagents: string) =>
      `---\nname: ${name}\ndescription: d\nlimit: 50000\ntools: []\nskills: []\nsubagents: ${subagents}\n---\n`;

    mkdirSync(join(dir, "chores"), { recursive: true });
    writeFileSync(join(dir, "chores", "mine.md"), file("mine", "[helper]"));
    writeFileSync(join(dir, "helper.md"), file("helper", "[]"));

    const loaded = loadDefinitions([{ path: dir, source: "project" }]).definitions;

    expect([loaded.get("mine"), loaded.get("helper")].map((entry) => entry && isLead(entry))).toEqual([
      true,
      false,
    ]);
  });
});

const indexOf = (records: AgentRecord[]) => new Map(records.map((record) => [record.id, record]));

const ids = (records: AgentRecord[]) => records.map((record) => record.id);

describe("chain walks", () => {
  it("stops at a predecessor cycle", () => {
    const records = indexOf([
      agentRecord({ id: "a", predecessorId: "c" }),
      agentRecord({ id: "b", predecessorId: "a" }),
      agentRecord({ id: "c", predecessorId: "b" }),
    ]);

    expect(ids(chainLinks(records, records.get("c") as AgentRecord))).toEqual(["a", "b", "c"]);
  });

  it("stops at a successor cycle", () => {
    const records = indexOf([
      agentRecord({ id: "a", successorId: "b" }),
      agentRecord({ id: "b", successorId: "c" }),
      agentRecord({ id: "c", successorId: "a" }),
    ]);

    expect(chainTerminal(records, records.get("a") as AgentRecord).id).toBe("c");
  });

  it("stops at a record that is its own predecessor or successor", () => {
    const record = agentRecord({ id: "a", predecessorId: "a", successorId: "a" });
    const records = indexOf([record]);

    expect(ids(chainLinks(records, record))).toEqual(["a"]);
    expect(chainTerminal(records, record).id).toBe("a");
  });
});
