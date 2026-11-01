import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../platform/pi-adapter/index.ts";
import {
  BACKGROUND_WORK_CHANNEL,
  HANDOFF_PENDING_CHANNEL,
  HELD_RESULTS_CHANNEL,
} from "../../../../../platform/shared/index.ts";
import { flushMicrotasks } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
  const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

  const start = (count: number) => {
    const agents = Array.from({ length: count }, (_, index) => ({ agent: "scout", task: `task ${index}` }));

    return runAgent.execute({ agents }, {});
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
    harness.host.assistantStart();
  };

  harness.host.agentStart();

  return { ...harness, start, run, counts, answer };
};

describe("background work", () => {
  it("counts a background batch from its start until the model starts answering its wake", async () => {
    const { run, runtime, host, counts, answer } = setup();

    await run(2);
    await run(1);

    expect(counts()).toEqual([1, 2]);

    host.settle();
    runtime.children.forEach((child) => {
      child.finish("result");
    });
    await flushMicrotasks();

    expect(host.hidden).toHaveLength(1);
    expect(counts()).toEqual([1, 2]);

    answer();

    expect(counts()).toEqual([1, 2, 0]);
  });

  it("keeps a batch counted until its result is sent, even when the model answers meanwhile", async () => {
    const { run, runtime, host, counts } = setup();

    await run(1);
    host.assistantStart();

    expect(counts()).toEqual([1]);

    runtime.children[0].finish("done while busy");
    await flushMicrotasks();

    expect(host.hidden[0].delivery).toBe("followUp");
    expect(counts()).toEqual([1]);

    host.assistantStart();

    expect(counts()).toEqual([1, 0]);
  });

  it("keeps a wake sent after the run's last message pending through that run's settle", async () => {
    const { run, runtime, host, counts, answer } = setup();

    await run(1);
    host.assistantEnd();
    runtime.children[0].finish("late result");
    await flushMicrotasks();
    host.settle();

    expect(counts()).toEqual([1]);

    answer();

    expect(counts()).toEqual([1, 0]);
  });

  it("keeps a running batch pending through an idle", async () => {
    const { run, host, counts } = setup();

    await run(1);
    host.assistantStart();
    host.assistantEnd();
    host.settle();

    expect(counts()).toEqual([1]);
  });

  it("drops a delivered wake when the user aborts the run", async () => {
    const { run, runtime, host, counts } = setup();

    await run(1);
    host.settle();
    runtime.children[0].finish("result");
    await flushMicrotasks();
    host.agentStart();
    host.settle({ aborted: true });

    expect(counts()).toEqual([1, 0]);
  });

  it("counts only the main session's batches, not the ones an agent starts", async () => {
    const { runtime, host, counts } = setup();
    const result = await host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents: [{ agent: "general", task: "delegate" }] }, {});

    await flushMicrotasks();

    const nested = runtime.children[0].spec.customTools?.find(
      (tool) => tool.name === "run_agent",
    ) as unknown as ToolSpec<RunAgentParams, RunAgentDetails> | undefined;

    await nested?.execute({ agents: [{ agent: "scout", task: "look" }] }, {});
    await flushMicrotasks();

    expect(result.isError).not.toBe(true);
    expect(runtime.children).toHaveLength(2);
    expect(counts()).toEqual([1]);

    runtime.children[1].finish("looked");
    await flushMicrotasks();

    expect(counts()).toEqual([1]);
  });
});

describe("held results while a handoff is pending", () => {
  const holding = () => {
    const harness = setup();

    const pending = (value: boolean) =>
      harness.host.emit(HANDOFF_PENDING_CHANNEL, { source: "pi-session-limits", pending: value });

    const held = () =>
      harness.host.published
        .filter((entry) => entry.channel === HELD_RESULTS_CHANNEL)
        .map((entry) => entry.data as { source: string; text: string });

    const finish = async (index: number, text: string) => {
      harness.runtime.children[index].finish(text);
      await flushMicrotasks();
    };

    return { ...harness, pending, held, finish };
  };

  it("holds a result instead of waking the session and publishes it", async () => {
    const { run, host, pending, held, finish, counts } = holding();

    await run(1);
    host.settle();
    pending(true);
    await finish(0, "held result");

    expect(host.hidden).toEqual([]);
    expect(held()).toEqual([{ source: "pi-subagents", text: expect.stringContaining("held result") }]);
    expect(counts()).toEqual([1]);
  });

  it("publishes every held result each time another one arrives", async () => {
    const { run, host, pending, held, finish } = holding();

    await run(1);
    await run(1);
    host.settle();
    pending(true);
    await finish(0, "first result");
    await finish(1, "second result");

    expect(held()).toHaveLength(2);
    expect(held()[0].text).not.toContain("second result");
    expect(held()[1].text).toMatch(/first result[\s\S]*\n\n---\n\n[\s\S]*second result/);
  });

  it("wakes the session once with the held results when the handoff is no longer pending", async () => {
    const { run, host, pending, finish, counts, answer } = holding();

    await run(1);
    host.settle();
    pending(true);
    await finish(0, "held result");
    pending(false);
    await flushMicrotasks();

    expect(host.hidden).toHaveLength(1);
    expect(host.hidden[0].message.text).toContain("held result");

    answer();
    pending(true);
    pending(false);
    await flushMicrotasks();

    expect(host.hidden).toHaveLength(1);
    expect(counts()).toEqual([1, 0]);
  });

  it("publishes nothing held when no result arrived while the handoff was pending", async () => {
    const { run, host, pending, held } = holding();

    await run(1);
    pending(true);
    pending(false);
    await flushMicrotasks();

    expect(held()).toEqual([]);
    expect(host.hidden).toEqual([]);
  });
});
