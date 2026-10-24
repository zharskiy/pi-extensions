import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { flushMicrotasks } from "../../../../../test-framework/index.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import type { BatchItem, Runner } from "../../../src/plugins/run-agent/runner.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const HANDOFF =
  "## Status\npartial\n\n## Outcome\n- x\n\n## Evidence\n- y\n\n## Blocker\nnone\n\n## Next\n- z\n\n## Files touched\nnone";

const scouts = (count: number): BatchItem[] =>
  Array.from({ length: count }, (_, index) => ({ agent: "scout", task: `look ${index}` }));

const setup = async (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin], {
    overrides: {
      maxChildrenPerAgent: 3,
      maxConcurrent: 20,
      ...overrides,
    },
  });
  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;

  const runMain = async (agents: RunAgentParams["agents"]) => {
    harness.host.idle = false;

    const result = await harness.host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents }, { update: () => {} });

    await flushMicrotasks();

    return result;
  };

  await runMain([{ agent: "general", task: "lead" }]);
  harness.host.settle();

  const lead = registry.list()[0];
  const startFrom = (callerId: string, items: BatchItem[]) =>
    runner.startBatch(items, { callerId, wait: false });
  const nested = () => registry.list().filter((record) => record.agent === "scout");

  return { ...harness, registry, runner, runMain, lead, startFrom, nested };
};

const refusal = (id: string, cap: number, started: number) =>
  `agent ${id} may start at most ${cap} agents per run and has started ${started}; nothing was started. Finish with what you have and list the rest under Open.`;

describe("per-agent spawn cap", () => {
  it("lets an agent start agents up to the cap, counted across its batches", async () => {
    const { lead, startFrom, nested } = await setup();

    startFrom(lead.id, scouts(2));
    startFrom(lead.id, scouts(1));

    expect(nested()).toHaveLength(3);
    expect(() => startFrom(lead.id, scouts(1))).toThrow(refusal(lead.id, 3, 3));
    expect(nested()).toHaveLength(3);
  });

  it("refuses a batch that would pass the cap as a whole and counts none of it", async () => {
    const { lead, startFrom, nested } = await setup();

    startFrom(lead.id, scouts(2));

    expect(() => startFrom(lead.id, scouts(2))).toThrow(refusal(lead.id, 3, 2));
    expect(nested()).toHaveLength(2);

    startFrom(lead.id, scouts(1));

    expect(nested()).toHaveLength(3);
  });

  it("refuses the agent tool call with the same text", async () => {
    const { lead, runtime, nested } = await setup({ maxChildrenPerAgent: 1 });
    const tool = runtime.child(lead.id).spec.customTools?.find((spec) => spec.name === "run_agent");

    await expect(
      tool?.execute({ agents: scouts(2) } as never, { update: () => {} } as never),
    ).rejects.toThrow(refusal(lead.id, 1, 0));
    expect(nested()).toEqual([]);
  });

  it("refuses every agent batch at 0", async () => {
    const { lead, startFrom, nested } = await setup({ maxChildrenPerAgent: 0 });

    expect(() => startFrom(lead.id, scouts(1))).toThrow(refusal(lead.id, 0, 0));
    expect(nested()).toEqual([]);
  });

  it("does not cap the main session", async () => {
    const { runMain, registry } = await setup({ maxChildrenPerAgent: 0 });

    await runMain(scouts(4));
    await runMain(scouts(4));

    expect(registry.list()).toHaveLength(9);
  });

  it("shares one budget across a handoff chain", async () => {
    const { lead, startFrom, nested, registry, runtime } = await setup();

    startFrom(lead.id, scouts(2));
    runtime.child(lead.id).turn({ tokens: lead.contextLimit + 500, window: 1_000_000, percent: 20 });
    await flushMicrotasks();
    mkdirSync(dirname(lead.handoffPath), { recursive: true });
    writeFileSync(lead.handoffPath, HANDOFF);
    runtime.child(lead.id).finish(lead.handoffPath);
    await flushMicrotasks();

    const successor = (registry.get(lead.id) as AgentRecord).successorId as string;

    expect(successor).toBeDefined();
    expect(() => startFrom(successor, scouts(2))).toThrow(refusal(successor, 3, 2));

    startFrom(successor, scouts(1));

    expect(nested()).toHaveLength(3);
  });
});
