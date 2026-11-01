import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../platform/pi-adapter/index.ts";
import {
  type FakeChildSession,
  flushMicrotasks,
  hiddenMessageTexts,
} from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type {
  MessageAgentParams,
  RunAgentParams,
  StopAgentDetails,
  StopAgentParams,
} from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const WAKE_NOTE =
  "You are still woken with the batch result, including any partial output, once the whole batch is done; do not restart these agents or check on them.";

const childTool = <P, D>(child: FakeChildSession, name: string) => {
  const tool = child.spec.customTools?.find((spec) => spec.name === name);

  if (!tool) {
    throw new Error(`${child.id} has no ${name}`);
  }

  return tool as unknown as ToolSpec<P, D>;
};

const setup = (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], { overrides });
  const registry = harness.services.require("registry");
  const stopAgent = harness.host.tool<StopAgentParams, StopAgentDetails>("stop_agent");
  const messageAgent = harness.host.tool<MessageAgentParams, unknown>("message_agent");

  const runMain = async (agents: RunAgentParams["agents"]) => {
    await harness.host.tool<RunAgentParams, unknown>("run_agent").execute({ agents }, {});
    await flushMicrotasks();

    harness.host.settle();

    return registry.list().slice(-agents.length);
  };

  const stop = async (ids: string[], reason?: string) => {
    const result = await stopAgent.execute({ ids, reason }, {});

    await flushMicrotasks();

    return result;
  };

  const send = (id: string, message: string) => messageAgent.execute({ id, message }, {});

  return { ...harness, registry, runMain, stop, send };
};

describe("stop_agent", () => {
  it("stops a running agent at once and wakes the caller once with its partial output", async () => {
    const { runMain, stop, send, registry, runtime, host } = setup();
    const [record] = await runMain([{ agent: "scout", task: "map auth" }]);
    const child = runtime.child(record.id);

    child.text = "partial findings";

    const result = await stop([record.id], "the user dropped the task");

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe([`Stopped ${record.id}.`, WAKE_NOTE].join("\n"));
    expect(result.details).toEqual({ stopped: [record.id], skipped: [] });
    expect(child.aborted).toBe(true);
    expect(registry.get(record.id)).toMatchObject({
      state: "stopped",
      error: "stopped by the main session: the user dropped the task",
    });
    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("finished: 1 stopped.");
    expect(hiddenMessageTexts(host)[0]).toContain(
      "(unverified partial output: stopped by the main session: the user dropped the task)\n\npartial findings",
    );

    const refused = await send(record.id, "one more thing");

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is closed (stopped)");
  });

  it("names the main session as the stopper when no reason is given", async () => {
    const { runMain, stop, registry } = setup();
    const [record] = await runMain([{ agent: "scout", task: "map auth" }]);

    await stop([record.id]);

    expect(registry.get(record.id)?.error).toBe("stopped by the main session");
  });

  it("wakes only when the rest of the batch is closed too", async () => {
    const { runMain, stop, registry, runtime, host } = setup();
    const [stopped, running] = await runMain([
      { agent: "scout", task: "one" },
      { agent: "scout", task: "two" },
    ]);

    await stop([stopped.id]);

    expect(registry.get(stopped.id)?.state).toBe("stopped");
    expect(registry.get(running.id)?.state).toBe("running");
    expect(hiddenMessageTexts(host)).toEqual([]);

    runtime.child(running.id).finish("second result");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("finished: 1 stopped, 1 done");
    expect(hiddenMessageTexts(host)[0]).toContain("second result");
  });

  it("closes a queued agent at once and leaves the running one alone", async () => {
    const { runMain, stop, registry } = setup({ maxConcurrent: 1 });
    const [first, second] = await runMain([
      { agent: "scout", task: "one" },
      { agent: "scout", task: "two" },
    ]);

    expect(registry.get(second.id)?.state).toBe("queued");

    const result = await stop([second.id]);

    expect(result.text).toContain(`Stopped ${second.id}.`);
    expect(registry.get(second.id)?.state).toBe("stopped");
    expect(registry.get(first.id)?.state).toBe("running");
  });

  it("refuses unknown and closed ids with an error and changes nothing", async () => {
    const { runMain, stop, registry, runtime, host } = setup();
    const [finished, running] = await runMain([
      { agent: "scout", task: "one" },
      { agent: "scout", task: "two" },
    ]);

    runtime.child(finished.id).finish("first result");
    await flushMicrotasks();

    const result = await stop(["ghost", finished.id]);

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      ["Not stopped ghost: unknown agent.", `Not stopped ${finished.id}: already closed (done).`].join("\n"),
    );
    expect(result.details).toEqual({
      stopped: [],
      skipped: [
        { id: "ghost", reason: "unknown agent" },
        { id: finished.id, reason: "already closed (done)" },
      ],
    });
    expect(registry.get(finished.id)?.state).toBe("done");
    expect(registry.get(running.id)?.state).toBe("running");
    expect(hiddenMessageTexts(host)).toEqual([]);
  });

  it("stops what it can and reports the rest when ids are mixed", async () => {
    const { runMain, stop } = setup();
    const [record] = await runMain([{ agent: "scout", task: "one" }]);

    const result = await stop([record.id, "ghost"]);

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe(
      [`Stopped ${record.id}.`, "Not stopped ghost: unknown agent.", WAKE_NOTE].join("\n"),
    );
  });

  it("renders nothing when it stops and one error row when it stops nothing", async () => {
    const { runMain, stop, host } = setup();
    const [record] = await runMain([{ agent: "scout", task: "one" }]);

    const stopped = await stop([record.id]);
    const refused = await stop(["ghost"]);

    const quiet = host.renderTool("stop_agent", { call: { ids: [record.id] }, result: stopped });
    const failed = host.renderTool("stop_agent", { call: { ids: ["ghost"] }, result: refused });

    expect(quiet.call).toBe("");
    expect(quiet.result).toBe("");
    expect(failed.result).toBe("✗ stop_agent ghost · ghost: unknown agent");
  });
});

describe("stop_agent in nested agents", () => {
  const startGeneral = async (harness: ReturnType<typeof setup>) => {
    const [record] = await harness.runMain([{ agent: "general", task: "investigate and fix" }]);

    return { record, child: harness.runtime.child(record.id) };
  };

  const spawnFrom = async (parent: FakeChildSession, agents: RunAgentParams["agents"]) => {
    await childTool<RunAgentParams, unknown>(parent, "run_agent").execute({ agents }, {});
    await flushMicrotasks();
  };

  it("gives an agent that may start agents its own stop_agent", async () => {
    const harness = setup();
    const { child } = await startGeneral(harness);

    expect(child.spec.customTools?.map((tool) => tool.name)).toContain("stop_agent");
  });

  it("refuses to stop an agent another caller started and keeps it running", async () => {
    const harness = setup();
    const { child } = await startGeneral(harness);

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    const helper = harness.registry.list()[1];
    const result = await harness.stop([helper.id]);

    expect(result.isError).toBe(true);
    expect(result.text).toBe(`Not stopped ${helper.id}: only the caller that started it may stop it.`);
    expect(harness.registry.get(helper.id)?.state).toBe("running");
    expect(harness.runtime.child(helper.id).aborted).toBe(false);
  });

  it("lets a child stop its own helper and wakes the child, not the main session", async () => {
    const harness = setup();
    const { record, child } = await startGeneral(harness);

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    const helper = harness.registry.list()[1];
    const stopTool = childTool<StopAgentParams, StopAgentDetails>(child, "stop_agent");

    child.finish("Started batch, waiting.");
    await flushMicrotasks();

    const result = await stopTool.execute({ ids: [helper.id] }, {});

    await flushMicrotasks();

    expect(result.text).toContain(`Stopped ${helper.id}.`);
    expect(harness.registry.get(helper.id)).toMatchObject({
      state: "stopped",
      error: `stopped by ${record.id}`,
    });
    expect(child.hidden).toHaveLength(1);
    expect(child.hidden[0]?.text).toContain("finished: 1 stopped.");
    expect(hiddenMessageTexts(harness.host)).toEqual([]);
    expect(harness.registry.get(record.id)?.state).toBe("running");
  });

  it("stops the children of an agent it stops", async () => {
    const harness = setup();
    const { record, child } = await startGeneral(harness);

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    const helper = harness.registry.list()[1];

    await harness.stop([record.id]);

    expect(harness.registry.get(record.id)?.state).toBe("stopped");
    expect(harness.registry.get(helper.id)?.state).toBe("stopped");
    expect(hiddenMessageTexts(harness.host)).toHaveLength(1);
  });
});
