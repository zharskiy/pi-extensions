import { describe, expect, it } from "vitest";
import { BACKGROUND_WORK_CHANNEL } from "../../../../../platform/shared/index.ts";
import { flushMicrotasks } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
  const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

  const start = (count: number, wait = false) => {
    const agents = Array.from({ length: count }, (_, index) => ({ agent: "scout", task: `task ${index}` }));

    return runAgent.execute({ agents, wait }, { update: () => {} });
  };

  const run = async (count: number) => {
    await start(count);
    await flushMicrotasks();
  };

  const counts = () =>
    harness.host.published
      .filter((entry) => entry.channel === BACKGROUND_WORK_CHANNEL)
      .map((entry) => (entry.data as { count: number }).count);

  const answer = () => {
    harness.host.agentStart();
    harness.host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
  };

  harness.host.agentStart();

  return { ...harness, start, run, counts, answer };
};

describe("background work", () => {
  it("publishes no pending work at session start", () => {
    const { host } = setup();

    expect(host.published.filter((entry) => entry.channel === BACKGROUND_WORK_CHANNEL)).toEqual([
      { channel: BACKGROUND_WORK_CHANNEL, data: { source: "pi-subagents", count: 0 } },
    ]);
  });

  it("counts a background batch from its start until the model answered its wake and the session settled", async () => {
    const { run, runtime, host, counts, answer } = setup();

    await run(2);
    await run(1);

    expect(counts()).toEqual([0, 1, 2]);

    host.settle();
    runtime.children.forEach((child) => {
      child.finish("result");
    });
    await flushMicrotasks();

    expect(host.hidden).toHaveLength(1);
    expect(counts()).toEqual([0, 1, 2]);

    answer();

    expect(counts()).toEqual([0, 1, 2]);

    host.settle();

    expect(counts()).toEqual([0, 1, 2, 0]);
  });

  it("keeps a wake that joins a busy run pending until that run settles", async () => {
    const { run, runtime, host, counts } = setup();

    await run(1);
    runtime.children[0].finish("done while busy");
    await flushMicrotasks();

    expect(host.hidden[0].delivery).toBe("followUp");

    host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

    expect(counts()).toEqual([0, 1]);

    host.settle();

    expect(counts()).toEqual([0, 1, 0]);
  });

  it("keeps a wake sent after the run's last message pending through that run's settle", async () => {
    const { run, runtime, host, counts, answer } = setup();

    await run(1);
    host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
    runtime.children[0].finish("late result");
    await flushMicrotasks();
    host.settle();

    expect(counts()).toEqual([0, 1]);

    answer();
    host.settle();

    expect(counts()).toEqual([0, 1, 0]);
  });

  it("keeps a running batch pending through an idle", async () => {
    const { run, host, counts } = setup();

    await run(1);
    host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
    host.settle();

    expect(counts()).toEqual([0, 1]);
  });

  it("drops a delivered wake when the user aborts the run", async () => {
    const { run, runtime, host, counts } = setup();

    await run(1);
    host.settle();
    runtime.children[0].finish("result");
    await flushMicrotasks();
    host.agentStart();
    host.settle({ aborted: true });

    expect(counts()).toEqual([0, 1, 0]);
  });

  it("does not count a batch the model waits for", async () => {
    const { start, runtime, counts } = setup();
    const result = start(1, true);

    await flushMicrotasks();
    runtime.children[0].finish("waited");
    await result;

    expect(counts()).toEqual([0]);
  });
});
