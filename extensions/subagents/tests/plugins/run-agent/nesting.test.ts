import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../platform/pi-adapter/index.ts";
import {
  type FakeChildSession,
  flushMicrotasks,
  hiddenMessageTexts,
} from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { agentStatusPlugin } from "../../../api/plugins/agent-status.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { Runner } from "../../../core/run-agent/runner.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentStatusPlugin];

const childTool = <P>(child: FakeChildSession, name: string) => {
  const tool = child.spec.customTools?.find((spec) => spec.name === name);

  if (!tool) {
    throw new Error(`${child.id} has no ${name}`);
  }

  return tool as unknown as ToolSpec<P, RunAgentDetails>;
};

const setup = (overrides = {}) => {
  const harness = createHarness(plugins, { overrides });
  const registry = harness.services.require("registry");

  const runMain = async (agents: RunAgentParams["agents"]) => {
    harness.host.idle = false;

    const result = await harness.host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents }, {});

    await flushMicrotasks();

    return result;
  };

  const startGeneral = async () => {
    await runMain([{ agent: "general", task: "investigate and fix" }]);

    const record = registry.list()[0];

    return { record, child: harness.runtime.child(record.id) };
  };

  const spawnFrom = async (parent: FakeChildSession, agents: RunAgentParams["agents"]) => {
    const result = await childTool<RunAgentParams>(parent, "run_agent").execute({ agents }, {});

    await flushMicrotasks();

    return result;
  };

  return { ...harness, registry, runMain, startGeneral, spawnFrom };
};

describe("nested agents", () => {
  it("gives an agent with subagents the agent tools, described from its own list", async () => {
    const { startGeneral, runMain, runtime } = setup();
    const { child } = await startGeneral();

    expect(child.spec.customTools?.map((tool) => tool.name)).toEqual([
      "handoff",
      "run_agent",
      "message_agent",
      "agent_status",
    ]);

    const description = childTool(child, "run_agent").description;

    expect(description).toContain("- scout:");
    expect(description).toContain("- reviewer:");
    expect(description).toContain("- implementer:");
    expect(description).toContain("you run at depth 2; agents you start run at depth 3 of at most 3");

    await runMain([{ agent: "scout", task: "look" }]);

    expect(runtime.children[1].spec.customTools?.map((tool) => tool.name)).toEqual(["handoff"]);
  });

  it("gives no agent tools at the depth cap", async () => {
    const { startGeneral } = setup({ maxDepth: 2 });
    const { child } = await startGeneral();

    expect(child.spec.customTools?.map((tool) => tool.name)).toEqual(["handoff"]);
  });

  it("starts grandchildren with the child as caller and wakes the child once, not the main session", async () => {
    const { startGeneral, spawnFrom, registry, runtime, host } = setup();
    const { record, child } = await startGeneral();

    const started = await spawnFrom(child, [
      { agent: "scout", task: "find a" },
      { agent: "reviewer", task: "check b" },
    ]);

    expect(started.text).toContain("Started batch");

    const [, scout, reviewer] = registry.list();

    expect([scout.callerId, scout.depth, reviewer.callerId]).toEqual([record.id, 3, record.id]);
    expect(runtime.child(scout.id).task).toContain(`Task from ${record.id} (agent id ${scout.id})`);

    child.finish(`Started batch, waiting.`);
    await flushMicrotasks();

    expect(registry.get(record.id)?.state).toBe("running");

    runtime.child(scout.id).finish("a is in src/a.ts");
    await flushMicrotasks();

    expect(child.hidden).toEqual([]);

    runtime.child(reviewer.id).finish("b looks fine");
    await flushMicrotasks();

    expect(child.hidden).toHaveLength(1);
    expect(child.hidden[0]?.customType).toBe("pi-subagents:wake");
    expect(child.hidden[0]?.text).toContain("a is in src/a.ts");
    expect(child.hidden[0]?.text).toContain("b looks fine");
    expect(hiddenMessageTexts(host)).toEqual([]);

    host.settle();
    child.finish("fixed it");
    await flushMicrotasks();

    expect(registry.get(record.id)?.state).toBe("done");
    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("fixed it");
    expect(child.hidden).toHaveLength(1);
  });

  it("clears the activity while an agent waits for its own batch", async () => {
    const { startGeneral, spawnFrom, registry } = setup();
    const { record, child } = await startGeneral();

    child.emit({ type: "tool_start", toolName: "run_agent" });
    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    expect(registry.get(record.id)?.activity).toBe("run_agent");

    child.finish("Started batch, waiting.");
    await flushMicrotasks();

    expect(registry.get(record.id)?.state).toBe("running");
    expect(registry.get(record.id)?.activity).toBeUndefined();
  });

  it("holds a child's wake until its current turn ends", async () => {
    const { startGeneral, spawnFrom, registry, runtime } = setup();
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    const scout = registry.list()[1];

    runtime.child(scout.id).finish("found a");
    await flushMicrotasks();

    expect(child.hidden).toEqual([]);

    child.finish("turn over");
    await flushMicrotasks();

    expect(child.hidden).toHaveLength(1);
    expect(registry.get(record.id)?.state).toBe("running");
  });

  it("does not deadlock with one slot: an idle parent waiting for its batch holds none", async () => {
    const { startGeneral, spawnFrom, registry, runtime, host } = setup({ maxConcurrent: 1 });
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    const scout = registry.list()[1];

    expect(runtime.children).toHaveLength(1);
    expect(scout.state).toBe("queued");

    child.finish("waiting for the scout");
    await flushMicrotasks();

    expect(runtime.children).toHaveLength(2);
    expect(registry.get(scout.id)?.state).toBe("running");

    runtime.child(scout.id).finish("found a");
    await flushMicrotasks();

    expect(child.hidden).toHaveLength(1);

    host.settle();
    child.finish("all done");
    await flushMicrotasks();

    expect(registry.get(record.id)?.state).toBe("done");
    expect(hiddenMessageTexts(host)).toHaveLength(1);
  });

  it("frees the slot of a caller stopped while its batch runs", async () => {
    const { startGeneral, spawnFrom, runMain, registry, runtime, services } = setup({ maxConcurrent: 1 });
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);
    child.finish("waiting for the scout");
    await flushMicrotasks();

    await (services.require("runner") as Runner).stop(record.id, { immediate: true });
    await flushMicrotasks();

    expect(registry.list().map((entry) => entry.state)).toEqual(["stopped", "stopped"]);

    await runMain([{ agent: "scout", task: "later" }]);

    expect(registry.list()[2].state).toBe("running");
    expect(runtime.children).toHaveLength(3);
  });

  it("wakes once and takes the slot back when a batch settles before the caller's turn ends", async () => {
    const { startGeneral, spawnFrom, runMain, registry, runtime, services } = setup({ maxConcurrent: 1 });
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);

    const scout = registry.list()[1];

    await (services.require("runner") as Runner).stop(scout.id);
    await flushMicrotasks();

    expect(registry.get(scout.id)?.state).toBe("stopped");
    expect(child.hidden).toEqual([]);

    child.finish("turn over");
    await flushMicrotasks();

    expect(child.hidden).toHaveLength(1);
    expect(child.hidden[0]?.text).toContain(`${scout.id} (scout) - stopped`);

    await runMain([{ agent: "scout", task: "later" }]);

    const later = registry.list()[2];

    expect(later.state).toBe("queued");

    child.finish("done");
    await flushMicrotasks();

    expect(registry.get(record.id)?.state).toBe("done");
    expect(registry.get(later.id)?.state).toBe("running");
    expect(runtime.children).toHaveLength(2);
    expect(child.hidden).toHaveLength(1);
  });

  it("never wakes a child caller whose batch is open at shutdown", async () => {
    const { startGeneral, spawnFrom, host } = setup();
    const { child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);
    child.finish("waiting for the scout");
    await flushMicrotasks();

    await host.shutdown("quit");
    await flushMicrotasks();

    expect(child.hidden).toEqual([]);
  });

  it("records nested agents as interrupted, not stopped by the user, at shutdown", async () => {
    const { startGeneral, spawnFrom, registry, host } = setup();
    const { child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);
    await host.shutdown("quit");

    expect(registry.list().map((entry) => [entry.state, entry.error])).toEqual([
      ["failed", "interrupted: session quit"],
      ["failed", "interrupted: session quit"],
    ]);
  });

  it("holds messages while an idle caller waits for a slot and delivers them with its turn", async () => {
    const { startGeneral, spawnFrom, registry, runtime, host } = setup({ maxConcurrent: 1 });
    const { record, child } = await startGeneral();
    const message = host.tool<{ id: string; message: string }, { delivery?: string }>("message_agent");
    const send = (text: string) => message.execute({ id: record.id, message: text }, {});

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);
    child.finish("waiting for the scout");
    await flushMicrotasks();

    const scout = registry.list()[1];

    expect(registry.get(scout.id)?.state).toBe("running");
    expect((await send("first")).details?.delivery).toBe("followUp");
    expect((await send("second")).details?.delivery).toBe("held");
    expect(child.messages).toEqual([]);

    runtime.child(scout.id).finish("found a");
    await flushMicrotasks();

    expect(child.messages.map((entry) => [entry.message.text, entry.delivery])).toEqual([
      ["first", "followUp"],
      ["second", "steer"],
    ]);
    expect(child.hidden).toEqual([]);

    child.finish("read the messages");
    await flushMicrotasks();

    expect(child.hidden).toHaveLength(1);
    expect(child.hidden[0]?.text).toContain("found a");
  });

  it("lets a child message only the agents it started", async () => {
    const { startGeneral, spawnFrom, registry, runMain } = setup();
    const { child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);
    await runMain([{ agent: "scout", task: "other" }]);

    const [, own, foreign] = registry.list();
    const message = childTool<{ id: string; message: string }>(child, "message_agent");

    const allowed = await message.execute({ id: own.id, message: "also b" }, {});
    const denied = await message.execute({ id: foreign.id, message: "x" }, {});

    expect(allowed.text).toContain(`Message delivered to ${own.id}`);
    expect(denied.text).toContain(`only the caller that started ${foreign.id}`);
  });

  it("stops a closed agent's open children", async () => {
    const { startGeneral, spawnFrom, registry, services } = setup();
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "scout", task: "find a" }]);
    await (services.require("runner") as Runner).stop(record.id, { immediate: true });
    await flushMicrotasks();

    const scout = registry.list()[1];

    expect(registry.get(record.id)?.state).toBe("stopped");
    expect(scout.state).toBe("stopped");
  });
});
