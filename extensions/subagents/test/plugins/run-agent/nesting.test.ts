import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../core/adapter/contract.ts";
import { type FakeChild, flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

const plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentStatusPlugin];

const childTool = <P>(child: FakeChild, name: string) => {
  const tool = child.spec.customTools?.find((spec) => spec.name === name);

  if (!tool) {
    throw new Error(`${child.id} has no ${name}`);
  }

  return tool as unknown as ToolSpec<P, RunAgentDetails>;
};

const setup = (overrides = {}) => {
  const harness = createHarness(plugins, overrides);
  const registry = harness.services.require("registry");

  const runMain = async (agents: RunAgentParams["agents"]) => {
    harness.host.idle = false;

    const result = await harness.host
      .tool<RunAgentParams, RunAgentDetails>("run_agent")
      .execute({ agents }, { update: () => {} });

    await flush();

    return result;
  };

  const startGeneral = async () => {
    await runMain([{ agent: "general", task: "investigate and fix" }]);

    const record = registry.list()[0];

    return { record, child: harness.runtime.child(record.id) };
  };

  const spawnFrom = async (parent: FakeChild, agents: RunAgentParams["agents"]) => {
    const result = await childTool<RunAgentParams>(parent, "run_agent").execute(
      { agents },
      { update: () => {} },
    );

    await flush();

    return result;
  };

  return { ...harness, registry, runMain, startGeneral, spawnFrom };
};

describe("nested agents", () => {
  it("gives an agent with subagents the agent tools, described from its own list", async () => {
    const { startGeneral, runMain, runtime } = setup();
    const { child } = await startGeneral();

    expect(child.spec.customTools?.map((tool) => tool.name)).toEqual([
      "run_agent",
      "message_agent",
      "agent_status",
    ]);

    const description = childTool(child, "run_agent").description;

    expect(description).toContain("- explorer:");
    expect(description).toContain("- reviewer:");
    expect(description).not.toContain("- implementer:");
    expect(description).toContain("you run at depth 2; agents you start run at depth 3 of at most 3");

    await runMain([{ agent: "explorer", task: "look" }]);

    expect(runtime.children[1].spec.customTools).toEqual([]);
  });

  it("gives no agent tools at the depth cap", async () => {
    const { startGeneral } = setup({ maxDepth: 2 });
    const { child } = await startGeneral();

    expect(child.spec.customTools).toEqual([]);
  });

  it("starts grandchildren with the child as caller and wakes the child once, not the main session", async () => {
    const { startGeneral, spawnFrom, registry, runtime, host } = setup();
    const { record, child } = await startGeneral();

    const started = await spawnFrom(child, [
      { agent: "explorer", task: "find a" },
      { agent: "reviewer", task: "check b" },
    ]);

    expect(started.text).toContain("Started batch");

    const [, explorer, reviewer] = registry.list();

    expect([explorer.callerId, explorer.depth, reviewer.callerId]).toEqual([record.id, 3, record.id]);
    expect(runtime.child(explorer.id).task).toContain(`Task from ${record.id} (agent id ${explorer.id})`);

    child.finish(`Started batch, waiting.`);
    await flush();

    expect(registry.get(record.id)?.state).toBe("running");

    runtime.child(explorer.id).finish("a is in src/a.ts");
    await flush();

    expect(child.wakes).toEqual([]);

    runtime.child(reviewer.id).finish("b looks fine");
    await flush();

    expect(child.wakes).toHaveLength(1);
    expect(child.wakes[0]).toContain("a is in src/a.ts");
    expect(child.wakes[0]).toContain("b looks fine");
    expect(host.sent).toEqual([]);

    host.settle();
    child.finish("fixed it");
    await flush();

    expect(registry.get(record.id)?.state).toBe("done");
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toContain("fixed it");
    expect(child.wakes).toHaveLength(1);
  });

  it("holds a child's wake until its current turn ends", async () => {
    const { startGeneral, spawnFrom, registry, runtime } = setup();
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "explorer", task: "find a" }]);

    const explorer = registry.list()[1];

    runtime.child(explorer.id).finish("found a");
    await flush();

    expect(child.wakes).toEqual([]);

    child.finish("turn over");
    await flush();

    expect(child.wakes).toHaveLength(1);
    expect(registry.get(record.id)?.state).toBe("running");
  });

  it("does not deadlock with one slot: an idle parent waiting for its batch holds none", async () => {
    const { startGeneral, spawnFrom, registry, runtime, host } = setup({ maxConcurrent: 1 });
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "explorer", task: "find a" }]);

    const explorer = registry.list()[1];

    expect(runtime.children).toHaveLength(1);
    expect(explorer.state).toBe("queued");

    child.finish("waiting for the explorer");
    await flush();

    expect(runtime.children).toHaveLength(2);
    expect(registry.get(explorer.id)?.state).toBe("running");

    runtime.child(explorer.id).finish("found a");
    await flush();

    expect(child.wakes).toHaveLength(1);

    host.settle();
    child.finish("all done");
    await flush();

    expect(registry.get(record.id)?.state).toBe("done");
    expect(host.sent).toHaveLength(1);
  });

  it("releases a waiting child's slot while it blocks on a batch with wait", async () => {
    const { startGeneral, registry, runtime } = setup({ maxConcurrent: 1 });
    const { child } = await startGeneral();

    const pending = childTool<RunAgentParams>(child, "run_agent").execute(
      { agents: [{ agent: "explorer", task: "find a" }], wait: true },
      { update: () => {} },
    );

    await flush();

    expect(runtime.children).toHaveLength(2);

    runtime.child(registry.list()[1].id).finish("found a");

    const result = await pending;

    expect(result.text).toContain("found a");
  });

  it("does not keep a slot for a waiting caller that closed before its batch settled", async () => {
    const { startGeneral, runMain, registry, runtime, services } = setup({ maxConcurrent: 1 });
    const { record, child } = await startGeneral();

    void childTool<RunAgentParams>(child, "run_agent").execute(
      { agents: [{ agent: "explorer", task: "find a" }], wait: true },
      { update: () => {} },
    );
    await flush();

    await (services.require("runner") as Runner).stop(record.id, { immediate: true });
    await flush();

    expect(registry.list().map((entry) => entry.state)).toEqual(["stopped", "stopped"]);

    await runMain([{ agent: "explorer", task: "later" }]);

    expect(registry.list()[2].state).toBe("running");
    expect(runtime.children).toHaveLength(3);
  });

  it("resolves a waiting caller's batch when the session shuts down", async () => {
    const { startGeneral, host } = setup();
    const { child } = await startGeneral();

    const pending = childTool<RunAgentParams>(child, "run_agent").execute(
      { agents: [{ agent: "explorer", task: "find a" }], wait: true },
      { update: () => {} },
    );
    await flush();

    await host.shutdown("quit");

    expect((await pending).text).toContain("finished: 1 failed");
  });

  it("records nested agents as interrupted, not stopped by the user, at shutdown", async () => {
    const { startGeneral, spawnFrom, registry, host } = setup();
    const { child } = await startGeneral();

    await spawnFrom(child, [{ agent: "explorer", task: "find a" }]);
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
    const send = (text: string) => message.execute({ id: record.id, message: text }, { update: () => {} });

    await spawnFrom(child, [{ agent: "explorer", task: "find a" }]);
    child.finish("waiting for the explorer");
    await flush();

    const explorer = registry.list()[1];

    expect(registry.get(explorer.id)?.state).toBe("running");
    expect((await send("first")).details?.delivery).toBe("followUp");
    expect((await send("second")).details?.delivery).toBe("held");
    expect(child.messages).toEqual([]);

    runtime.child(explorer.id).finish("found a");
    await flush();

    expect(child.messages.map((entry) => [entry.message.text, entry.delivery])).toEqual([
      ["first", "followUp"],
      ["second", "steer"],
    ]);
    expect(child.wakes).toEqual([]);

    child.finish("read the messages");
    await flush();

    expect(child.wakes).toHaveLength(1);
    expect(child.wakes[0]).toContain("found a");
  });

  it("lets a child message only the agents it started", async () => {
    const { startGeneral, spawnFrom, registry, runMain } = setup();
    const { child } = await startGeneral();

    await spawnFrom(child, [{ agent: "explorer", task: "find a" }]);
    await runMain([{ agent: "explorer", task: "other" }]);

    const [, own, foreign] = registry.list();
    const message = childTool<{ id: string; message: string }>(child, "message_agent");

    const allowed = await message.execute({ id: own.id, message: "also b" }, { update: () => {} });
    const denied = await message.execute({ id: foreign.id, message: "x" }, { update: () => {} });

    expect(allowed.text).toContain(`Message delivered to ${own.id}`);
    expect(denied.text).toContain(`only the caller that started ${foreign.id}`);
  });

  it("stops a closed agent's open children", async () => {
    const { startGeneral, spawnFrom, registry, services } = setup();
    const { record, child } = await startGeneral();

    await spawnFrom(child, [{ agent: "explorer", task: "find a" }]);
    await (services.require("runner") as Runner).stop(record.id, { immediate: true });
    await flush();

    const explorer = registry.list()[1];

    expect(registry.get(record.id)?.state).toBe("stopped");
    expect(explorer.state).toBe("stopped");
  });
});
