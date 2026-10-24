import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../pi-adapter/index.ts";
import { USAGE_CHANNEL } from "../../../../../shared/index.ts";
import { type FakeChildSession, flushMicrotasks, usageTotals } from "../../../../../test-framework/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { usageReportPlugin } from "../../../src/plugins/usage-report/index.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, usageReportPlugin];

const setup = () => {
  const harness = createHarness(plugins);
  const registry = harness.services.require("registry");

  harness.host.onSessionShutdown(async () => {
    await harness.manager.disableAll();
  });

  const reports = () =>
    harness.host.published
      .filter((entry) => entry.channel === USAGE_CHANNEL)
      .map((entry) => entry.data as { source: string; id: string; usage: { cost: { total: number } } });

  const startGeneral = async () => {
    harness.host.idle = false;

    await harness.host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents: [{ agent: "general", task: "investigate" }] }, { update: () => {} });

    await flushMicrotasks();

    return harness.runtime.child(registry.list()[0].id);
  };

  const spawnFrom = async (parent: FakeChildSession, agent: string) => {
    const tool = parent.spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as ToolSpec<
      RunAgentParams,
      RunAgentDetails
    >;

    await tool.execute({ agents: [{ agent, task: "look" }] }, { update: () => {} });
    await flushMicrotasks();

    return harness.runtime.child(registry.list().at(-1)?.id ?? "");
  };

  return { ...harness, registry, reports, startGeneral, spawnFrom };
};

describe("usage report", () => {
  it("reports every agent under its own id, nested agents included", async () => {
    const { startGeneral, spawnFrom, reports } = setup();
    const child = await startGeneral();
    const grandchild = await spawnFrom(child, "scout");

    child.usage = usageTotals(0.1);
    grandchild.usage = usageTotals(0.2);
    child.turn({});
    grandchild.turn({});
    await flushMicrotasks();

    expect(reports().map((report) => [report.source, report.id, report.usage.cost.total])).toEqual([
      ["agents", child.id, 0.1],
      ["agents", grandchild.id, 0.2],
    ]);
  });

  it("keeps each agent's own cost on its record", async () => {
    const { startGeneral, spawnFrom, registry } = setup();
    const child = await startGeneral();
    const grandchild = await spawnFrom(child, "scout");

    expect(registry.get(child.id)?.cost).toBe(0);

    child.usage = usageTotals(0.1);
    grandchild.usage = usageTotals(0.2);
    child.turn({});
    grandchild.turn({});
    await flushMicrotasks();

    expect([registry.get(child.id)?.cost, registry.get(grandchild.id)?.cost]).toEqual([0.1, 0.2]);

    child.usage = usageTotals(0.3);
    child.finish("done");
    await flushMicrotasks();

    expect(registry.get(child.id)?.cost).toBe(0.3);
  });

  it("stops publishing once disabled", async () => {
    const { startGeneral, reports, bus, manager } = setup();
    const child = await startGeneral();

    await manager.disableAll();
    bus.emit("agent:usage", { id: child.id, usage: usageTotals(0.2) });

    expect(reports()).toEqual([]);
  });

  it("publishes the last usage of an agent whose abort settles late during shutdown", async () => {
    const { startGeneral, reports, host } = setup();
    const child = await startGeneral();

    child.usage = usageTotals(0.1);
    child.turn({});
    await flushMicrotasks();

    child.usage = usageTotals(0.4);
    child.abortDelayMs = 5;
    await host.shutdown();

    expect(child.aborted).toBe(true);
    const costs = reports().map((report) => report.usage.cost.total);

    expect(costs[0]).toBe(0.1);
    expect(costs.at(-1)).toBe(0.4);
  });
});
