import { describe, expect, it, vi } from "vitest";
import { flushMicrotasks, usageTotals } from "../../../../../test-framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { agentStatusPlugin } from "../../../api/plugins/agent-status.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { AgentStatusDetails, AgentStatusParams } from "../../../core/agent-status/snapshot.ts";
import { type AgentSnapshot, snapshotLine, snapshotOf } from "../../../core/agent-status/snapshot.ts";
import type { RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

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

    await harness.runAgent.execute({ agents: [{ agent: "scout", task: "one" }] }, { update: () => {} });
    await flushMicrotasks();

    const registry = harness.services.require("registry");
    const [record] = registry.list();

    expect(snapshotLine(snapshotOf(record, Date.now()))).toContain(`(scout, ${record.model}) running`);
  });

  it("returns a snapshot for one or several agents in one call", async () => {
    const harness = setup();

    await harness.runAgent.execute(
      {
        agents: [
          { agent: "scout", task: "one" },
          { agent: "reviewer", task: "two" },
        ],
      },
      { update: () => {} },
    );
    await flushMicrotasks();

    const [first, second] = harness.services.require("registry").list();
    const child = harness.runtime.child(first.id);

    child.emit({ type: "tool_start", toolName: "grep" });
    child.emit({
      type: "assistant_message",
      text: "Looking at src/auth.ts\nfound the handler",
      stopReason: "toolUse",
      toolCalls: 1,
    });
    child.usage = usageTotals(0.01, 1_000);
    child.turn({ tokens: 30_000, window: 200_000, percent: 15 });

    const result = await harness.status.execute(
      { ids: [first.id, second.id, "ghost-0000"] },
      { update: () => {} },
    );
    const snapshot = result.details?.agents[0];

    expect(snapshot).toMatchObject({
      id: first.id,
      agent: "scout",
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
        "cost",
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
        "tokens",
        "toolCalls",
        "worktree",
      ].sort(),
    );
    expect(result.details?.agents).toHaveLength(2);
    expect(result.details?.unknown).toEqual(["ghost-0000"]);
    expect(result.text).toContain(`${first.id} (scout, ${first.model}) running`);
    expect(result.text).toContain(" · 1 call · 2.0k tokens · 15% context");
    expect(result.text).toContain(" · 0 calls · 0 tokens · context n/a");
    expect(result.text).toContain("ghost-0000: unknown agent");

    harness.host.settle();
    child.finish("final answer");

    const after = await harness.status.execute({ ids: [first.id] }, { update: () => {} });

    expect(after.text).toContain(`result: ${harness.services.require("registry").get(first.id)?.resultPath}`);
  });

  it("shows the grace state with the seconds left after a stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const harness = setup();

    await harness.runAgent.execute({ agents: [{ agent: "scout", task: "x" }] }, { update: () => {} });
    await flushMicrotasks();

    const [record] = harness.services.require("registry").list();

    await harness.services.require("runner").stop(record.id);
    vi.advanceTimersByTime(15_000);

    const result = await harness.status.execute({ ids: [record.id] }, { update: () => {} });

    expect(result.details?.agents[0]).toMatchObject({ state: "grace", graceSecondsLeft: 45 });
    expect(result.text).toContain(
      `${record.id} (scout, ${record.model}) grace (closes in 45s unless messaged)`,
    );

    await harness.host.shutdown("quit");
    vi.useRealTimers();
  });

  it("reports a chain once when several of its ids are asked for", async () => {
    const harness = setup();
    const registry = harness.services.require("registry");

    const link = (chainIndex: number) =>
      registry.create({
        agent: "scout",
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

  it("tells every caller it is woken and must not poll", () => {
    const harness = setup();
    const child = harness.services.require("agentStatus").toolFor("caller");
    const rule = "You are woken when a batch you started is done; do not call this in a loop.";

    expect(harness.status.description).toContain(rule);
    expect(child.description).toContain(rule);
  });

  it("lists every agent when no ids are given", async () => {
    const harness = setup();
    const empty = await harness.status.execute({}, { update: () => {} });

    expect(empty.text).toBe("No agents in this session.");

    await harness.runAgent.execute({ agents: [{ agent: "scout", task: "x" }] }, { update: () => {} });

    const all = await harness.status.execute({}, { update: () => {} });

    expect(all.details?.agents).toHaveLength(1);
  });
});

describe("agent_status rows", () => {
  const details = (count: number): AgentStatusDetails => ({
    agents: Array.from({ length: count }, () => ({}) as AgentStatusDetails["agents"][number]),
    unknown: [],
  });

  it("names the ids, or all, after the bold title", () => {
    const { host } = setup();

    expect(host.renderTool("agent_status", { call: { ids: ["a-1", "b-2"] } }).call).toBe(
      "✓ agent_status a-1, b-2",
    );
    expect(host.renderTool("agent_status", { call: {} }).call).toBe("✓ agent_status all");
    expect(host.renderTool("agent_status", { call: {}, state: { isPartial: true } }).call).toBe(
      "◌ agent_status all",
    );
  });

  const snapshot = (patch: Partial<AgentSnapshot>): AgentSnapshot => ({
    id: "scout-1",
    agent: "scout",
    model: "prov/model-a:low",
    state: "done",
    description: "Map the auth module",
    elapsedMs: 65_000,
    tokens: 12_300,
    toolCalls: 4,
    cost: 0.04,
    contextPercent: 20,
    lastLine: "",
    chainIndex: 1,
    ...patch,
  });

  it("counts the agents until expanded, then shows the snapshot", () => {
    const { host } = setup();
    const result = { text: "a-1: running\nb-2: done", details: details(2) };

    expect(host.renderTool("agent_status", { result }).result).toBe(
      "  ↳ 2 agents (<app.tools.expand> to expand)",
    );
    expect(
      host.renderTool("agent_status", {
        result: { text: "No agents in this session.", details: { agents: [], unknown: [] } },
        state: { expanded: true },
      }).result,
    ).toBe("  ↳ No agents in this session.");
  });

  it("draws one agent row per agent at column 4 when expanded", () => {
    const { host } = setup();
    const agents = [
      snapshot({}),
      snapshot({
        id: "worker-2",
        agent: "worker",
        state: "running",
        description: "Fix the login redirect",
        elapsedMs: 42_000,
        toolCalls: 9,
        tokens: 6_100,
        cost: 0.01,
      }),
    ];
    const result = { text: "model text", details: { agents, unknown: ["gone-1"] } };
    const rendered = (width: number) =>
      host.renderTool("agent_status", { result, state: { expanded: true }, width }).result?.split("\n");

    expect(rendered(80)).toEqual([
      "    ✓ scout   Map the auth module   1m 5s · 4 calls · 12.3k tokens · $0.04",
      "    ◌ worker  Fix the login red...  Elapsed 42s · 9 calls · 6.1k tokens · $0.01",
      "    gone-1: unknown agent",
    ]);
    expect(rendered(120)?.[0]).toBe(
      "    ✓ scout   Map the auth module     model-a:low  1m 5s · 4 calls · 12.3k tokens · $0.04",
    );
    expect(rendered(41)).toEqual([
      "    ✓ scout   Map the a...  1m 5s",
      "    ◌ worker  Fix the l...  Elapsed 42s",
      "    gone-1: unknown agent",
    ]);
    expect(host.renderTool("agent_status", { result: { text: "x", details: details(1) } }).result).toBe(
      "  ↳ 1 agent (<app.tools.expand> to expand)",
    );
  });
});
