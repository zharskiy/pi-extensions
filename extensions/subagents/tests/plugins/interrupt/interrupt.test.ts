import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushMicrotasks } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { interruptPlugin } from "../../../api/plugins/interrupt.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import { plugins } from "../../../api/plugins.ts";
import { createHarness, spawnAgents } from "../../support/subagents-harness.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

const setup = async (count: number, disabledPlugins: string[] = []) => {
  const harness = createHarness(
    disabledPlugins.length > 0
      ? plugins
      : [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, interruptPlugin],
    { overrides: { disabledPlugins } },
  );
  const records = count > 0 ? await spawnAgents(harness, count) : [];
  const registry = harness.services.require("registry");
  const states = () => records.map((record) => registry.get(record.id)?.state);

  return { ...harness, ids: records.map((record) => record.id), states };
};

describe("Esc on an empty idle editor", () => {
  it("asks after a turn that ended on its own and stops the agents gracefully on Yes", async () => {
    const { host, ids, states } = await setup(2);

    expect(host.pressEmptyEscape()).toBe(true);
    await flushMicrotasks();

    expect(host.confirmations).toEqual([
      { title: "Stop running agents?", message: `2 agents are still running: ${ids.join(", ")}.` },
    ]);
    expect(states().every((state) => state === "grace" || state === "stopped")).toBe(true);
    expect(host.notices.at(-1)).toEqual({ message: "pi-subagents: stopping 2 agents", level: "info" });
  });

  it("asks the same after an aborted run", async () => {
    const { host, ids } = await setup(2);

    host.settle({ aborted: true });

    expect(host.pressEmptyEscape()).toBe(true);
    await flushMicrotasks();

    expect(host.confirmations[0]?.message).toBe(`2 agents are still running: ${ids.join(", ")}.`);
  });

  it("names three agents and counts the rest", async () => {
    const { host, ids } = await setup(5);

    host.pressEmptyEscape();
    await flushMicrotasks();

    expect(host.confirmations[0]?.message).toBe(
      `5 agents are still running: ${ids.slice(0, 3).join(", ")} and 2 more.`,
    );
  });

  it("leaves the agents on No and asks again on the next Esc", async () => {
    const { host, states } = await setup(1);

    host.confirmAnswer = false;

    expect(host.pressEmptyEscape()).toBe(true);
    await flushMicrotasks();

    expect(host.confirmations[0]?.message).toMatch(/^1 agent is still running: /);
    expect(states()).toEqual(["running"]);
    expect(host.notices).toEqual([]);
    expect(host.pressEmptyEscape()).toBe(true);
    expect(host.confirmations).toHaveLength(2);
  });

  it("leaves Esc to pi when no agent runs", async () => {
    const { host } = await setup(0);

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("leaves Esc to pi once every agent has finished", async () => {
    const { host, runtime } = await setup(2);

    runtime.children.forEach((child) => {
      child.finish("x");
    });
    await flushMicrotasks();

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("does not ask while pi is busy", async () => {
    const { host } = await setup(2);

    host.idle = false;

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("does nothing when the interrupt plugin is disabled", async () => {
    const { host } = await setup(2, ["interrupt"]);

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });
});
