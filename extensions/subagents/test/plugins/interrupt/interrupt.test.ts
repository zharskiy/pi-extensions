import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { interruptPlugin } from "../../../src/plugins/interrupt/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { plugins } from "../../../src/plugins.ts";
import { createHarness, spawnAgents } from "../../helpers/harness.ts";

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

describe("Esc after an interrupted turn", () => {
  it("asks to stop the running agents and stops them gracefully on Yes", async () => {
    const { host, ids, states } = await setup(2);

    host.settle({ aborted: true });

    expect(host.pressEmptyEscape()).toBe(true);
    await flush();

    expect(host.confirmations).toEqual([
      { title: "Stop running agents?", message: `2 agents are still running: ${ids.join(", ")}.` },
    ]);
    expect(states().every((state) => state === "grace" || state === "stopped")).toBe(true);
    expect(host.notices.at(-1)).toEqual({ message: "pi-subagents: stopping 2 agents", level: "info" });
  });

  it("names three agents and counts the rest", async () => {
    const { host, ids } = await setup(5);

    host.settle({ aborted: true });
    host.pressEmptyEscape();
    await flush();

    expect(host.confirmations[0]?.message).toBe(
      `5 agents are still running: ${ids.slice(0, 3).join(", ")} and 2 more.`,
    );
  });

  it("leaves the agents on No and hands the next Esc back to pi", async () => {
    const { host, states } = await setup(1);

    host.confirmAnswer = false;
    host.settle({ aborted: true });

    expect(host.pressEmptyEscape()).toBe(true);
    await flush();

    expect(host.confirmations[0]?.message).toMatch(/^1 agent is still running: /);
    expect(states()).toEqual(["running"]);
    expect(host.notices).toEqual([]);
    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toHaveLength(1);
  });

  it("leaves Esc to pi after a settle without abort", async () => {
    const { host } = await setup(2);

    host.settle();

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("leaves Esc to pi when no agent runs", async () => {
    const { host } = await setup(0);

    host.settle({ aborted: true });

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("disarms when a new run starts and settles normally", async () => {
    const { host } = await setup(2);

    host.settle({ aborted: true });
    host.agentStart();
    host.settle();

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("does not ask while pi is busy", async () => {
    const { host } = await setup(2);

    host.settle({ aborted: true });
    host.idle = false;

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });

  it("does nothing when the interrupt plugin is disabled", async () => {
    const { host } = await setup(2, ["interrupt"]);

    host.settle({ aborted: true });

    expect(host.pressEmptyEscape()).toBe(false);
    expect(host.confirmations).toEqual([]);
  });
});
