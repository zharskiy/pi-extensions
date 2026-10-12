import { describe, expect, it, vi } from "vitest";
import { flush, usageOf } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import {
  type AgentStatusDetails,
  type AgentStatusParams,
  agentStatusPlugin,
} from "../../../src/plugins/agent-status/index.ts";
import { snapshotLine, snapshotOf } from "../../../src/plugins/agent-status/snapshot.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

const setup = () => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    runAgentPlugin,
    agentStatusPlugin,
  ]);
  const status = harness.host.tool<AgentStatusParams, AgentStatusDetails>("agent_status");
  const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

  return { ...harness, status, runAgent };
};

describe("agent_status", () => {
  it("names the model next to the agent", async () => {
    const harness = setup();

    await harness.runAgent.execute({ agents: [{ agent: "explorer", task: "one" }] }, { update: () => {} });
    await flush();

    const registry = harness.services.require("registry");
    const [record] = registry.list();

    expect(snapshotLine(snapshotOf(record, Date.now()))).toContain(`(explorer, ${record.model}) running`);
  });

  it("returns a snapshot for one or several agents in one call", async () => {
    const harness = setup();

    await harness.runAgent.execute(
      {
        agents: [
          { agent: "explorer", task: "one" },
          { agent: "reviewer", task: "two" },
        ],
      },
      { update: () => {} },
    );
    await flush();

    const [first, second] = harness.services.require("registry").list();
    const child = harness.runtime.child(first.id);

    child.emit({ type: "tool_start", toolName: "grep" });
    child.emit({
      type: "assistant_message",
      text: "Looking at src/auth.ts\nfound the handler",
      stopReason: "toolUse",
      toolCalls: 1,
    });
    child.usage = usageOf(0.01, 1_000);
    child.turn({ tokens: 30_000, window: 200_000, percent: 15 });

    const result = await harness.status.execute(
      { ids: [first.id, second.id, "ghost-0000"] },
      { update: () => {} },
    );
    const snapshot = result.details?.agents[0];

    expect(snapshot).toMatchObject({
      id: first.id,
      agent: "explorer",
      model: first.model,
      state: "running",
      tokens: 2_000,
      toolCalls: 1,
      contextPercent: 15,
      lastLine: "found the handler",
    });
    expect(Object.keys(snapshot ?? {}).sort()).toEqual(
      [
        "agent",
        "chainIndex",
        "contextPercent",
        "description",
        "elapsedMs",
        "error",
        "graceSecondsLeft",
        "handoffPath",
        "id",
        "lastLine",
        "model",
        "predecessorId",
        "requestedId",
        "resultPath",
        "state",
        "successorId",
        "tokens",
        "toolCalls",
        "worktree",
      ].sort(),
    );
    expect(result.details?.agents).toHaveLength(2);
    expect(result.details?.unknown).toEqual(["ghost-0000"]);
    expect(result.text).toContain(`${first.id} (explorer, ${first.model}) running`);
    expect(result.text).toContain("ctx 15%");
    expect(result.text).toContain(" · 1 tool call · ctx 15%");
    expect(result.text).toContain("ghost-0000: unknown agent");

    harness.host.settle();
    child.finish("final answer");

    const after = await harness.status.execute({ ids: [first.id] }, { update: () => {} });

    expect(after.text).toContain(`result: ${harness.services.require("registry").get(first.id)?.resultPath}`);
  });

  it("shows the grace state with the seconds left after a stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const harness = setup();

    await harness.runAgent.execute({ agents: [{ agent: "explorer", task: "x" }] }, { update: () => {} });
    await flush();

    const [record] = harness.services.require("registry").list();

    await harness.services.require("runner").stop(record.id);
    vi.advanceTimersByTime(15_000);

    const result = await harness.status.execute({ ids: [record.id] }, { update: () => {} });

    expect(result.details?.agents[0]).toMatchObject({ state: "grace", graceSecondsLeft: 45 });
    expect(result.text).toContain(
      `${record.id} (explorer, ${record.model}) grace (closes in 45s unless messaged)`,
    );

    await harness.host.shutdown("quit");
    vi.useRealTimers();
  });

  it("reports a chain once when several of its ids are asked for", async () => {
    const harness = setup();
    const registry = harness.services.require("registry");

    const link = (chainIndex: number) =>
      registry.create({
        agent: "explorer",
        task: "t",
        description: "t",
        callerId: "main",
        depth: 2,
        batchId: "b-1",
        dir: harness.root,
        contextLimit: 100_000,
        chainIndex,
      });

    const first = link(1);
    const second = link(2);

    registry.update(first.id, { successorId: second.id });
    registry.update(second.id, { predecessorId: first.id });

    const result = await harness.status.execute({ ids: [first.id, second.id] }, { update: () => {} });

    expect(result.details?.agents.map((agent) => agent.id)).toEqual([second.id]);
    expect(result.text.split("\n")[0]).toMatch(new RegExp(`^${first.id} → ${second.id} `));
  });

  it("lists every agent when no ids are given", async () => {
    const harness = setup();
    const empty = await harness.status.execute({}, { update: () => {} });

    expect(empty.text).toBe("No agents in this session.");

    await harness.runAgent.execute({ agents: [{ agent: "explorer", task: "x" }] }, { update: () => {} });

    const all = await harness.status.execute({}, { update: () => {} });

    expect(all.details?.agents).toHaveLength(1);
  });
});
