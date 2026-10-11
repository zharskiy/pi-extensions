import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../core/adapter/contract.ts";
import { type FakeChild, flush, usageOf } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import {
  SPENDING_CHANNEL,
  SPENDING_SOURCE,
  usageReportPlugin,
} from "../../../src/plugins/usage-report/index.ts";
import { createHarness } from "../../helpers/harness.ts";

const agentId = (report: { id: string }) => report.id.slice(report.id.indexOf("/") + 1);

const plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, usageReportPlugin];

const setup = () => {
  const harness = createHarness(plugins);
  const registry = harness.services.require("registry");

  harness.host.onSessionShutdown(async () => {
    await harness.manager.disableAll();
  });

  const reports = () =>
    harness.host.published
      .filter((entry) => entry.channel === SPENDING_CHANNEL)
      .map((entry) => entry.data as { source: string; id: string; usage: { cost: { total: number } } });

  const startGeneral = async () => {
    harness.host.idle = false;

    await harness.host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents: [{ agent: "general", task: "investigate" }] }, { update: () => {} });

    await flush();

    return harness.runtime.child(registry.list()[0].id);
  };

  const spawnFrom = async (parent: FakeChild, agent: string) => {
    const tool = parent.spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as ToolSpec<
      RunAgentParams,
      RunAgentDetails
    >;

    await tool.execute({ agents: [{ agent, task: "look" }] }, { update: () => {} });
    await flush();

    return harness.runtime.child(registry.list().at(-1)?.id ?? "");
  };

  return { ...harness, registry, reports, startGeneral, spawnFrom };
};

describe("usage report", () => {
  it("reports every agent under its own id, nested agents included", async () => {
    const { startGeneral, spawnFrom, reports } = setup();
    const child = await startGeneral();
    const grandchild = await spawnFrom(child, "explorer");

    child.usage = usageOf(0.1);
    grandchild.usage = usageOf(0.2);
    child.turn({});
    grandchild.turn({});
    await flush();

    expect(reports().map((report) => [report.source, agentId(report), report.usage.cost.total])).toEqual([
      [SPENDING_SOURCE, child.id, 0.1],
      [SPENDING_SOURCE, grandchild.id, 0.2],
    ]);
  });

  it("publishes only usage ahead of what it last published for that id", async () => {
    const { startGeneral, reports, bus } = setup();
    const child = await startGeneral();

    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.1) });
    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.1) });
    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.05) });
    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.3) });

    expect(reports().map((report) => report.usage.cost.total)).toEqual([0.1, 0.3]);
  });

  it("prefixes every reported id with a token taken at session start", async () => {
    const { startGeneral, reports, host, bus } = setup();
    const child = await startGeneral();

    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.1) });

    const [first] = reports();

    expect(first.id).toMatch(new RegExp(`^[0-9a-z]+/${child.id}$`));

    await new Promise((resolve) => setTimeout(resolve, 2));
    host.start();
    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.1) });

    const second = reports()[1];

    expect(agentId(second)).toBe(child.id);
    expect(second.id).not.toBe(first.id);
  });

  it("forgets what it published when a new session starts", async () => {
    const { startGeneral, reports, host, bus } = setup();
    const child = await startGeneral();

    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.3) });
    host.start();
    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.1) });

    expect(reports().map((report) => report.usage.cost.total)).toEqual([0.3, 0.1]);
  });

  it("stops publishing once disabled", async () => {
    const { startGeneral, reports, bus, manager } = setup();
    const child = await startGeneral();

    await manager.disableAll();
    bus.emit("agent:usage", { id: child.id, usage: usageOf(0.2) });

    expect(reports()).toEqual([]);
  });

  it("publishes the last usage of an agent whose abort settles late during shutdown", async () => {
    const { startGeneral, reports, host } = setup();
    const child = await startGeneral();

    child.usage = usageOf(0.1);
    child.turn({});
    await flush();

    child.usage = usageOf(0.4);
    child.abortDelayMs = 5;
    await host.shutdown();

    expect(child.aborted).toBe(true);
    expect(reports().map((report) => report.usage.cost.total)).toEqual([0.1, 0.4]);
  });
});
