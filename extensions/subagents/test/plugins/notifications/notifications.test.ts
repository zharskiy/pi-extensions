import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../../../../core/adapter/contract.ts";
import { type FakeChild, flush } from "../../../../../core/test/helpers/fakes.ts";
import type { Plugin } from "../../../src/model/plugin.ts";
import type { Settings } from "../../../src/model/settings.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { notificationsPlugin } from "../../../src/plugins/notifications/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { plugins } from "../../../src/plugins.ts";
import { createHarness } from "../../helpers/harness.ts";

const setup = (
  overrides: Partial<Settings> = {},
  set: Plugin[] = [notificationsPlugin, runAgentPlugin, agentDefinitionsPlugin, agentRegistryPlugin],
) => {
  const harness = createHarness(set, overrides);

  const registry = harness.services.require("registry");

  const run = async (agents: RunAgentParams["agents"]) => {
    await harness.host.tool<RunAgentParams, unknown>("run_agent").execute({ agents }, { update: () => {} });
    await flush();
    harness.host.settle();

    return registry.list().map((record) => harness.runtime.child(record.id));
  };

  const finish = async (child: FakeChild, text: string, error?: string) => {
    child.finish(text, error ? { stopReason: "error", error } : {});
    await flush();
  };

  return { ...harness, registry, run, finish };
};

describe("notifications", () => {
  it("notifies once when a batch of the main session settles, naming agents and states", async () => {
    const { run, finish, host } = setup();
    const [first, second] = await run([
      { agent: "explorer", task: "find auth" },
      { agent: "reviewer", task: "review auth" },
    ]);

    await finish(first, "\nAuth lives in src/auth.ts.\nMore detail.");

    expect(host.terminalNotices).toEqual([]);

    await finish(second, "Looks fine.");

    expect(host.terminalNotices).toEqual([
      { title: `pi-subagents: ${first.id} done, ${second.id} done`, body: "Auth lives in src/auth.ts." },
    ]);
  });

  it("notifies when an agent fails and leaves the settled batch to the batch notice", async () => {
    const { run, finish, host } = setup();
    const [first, second] = await run([
      { agent: "explorer", task: "find auth" },
      { agent: "explorer", task: "find billing" },
    ]);

    await finish(first, "", "rate limited\nretry later");

    expect(host.terminalNotices).toEqual([
      { title: `pi-subagents: ${first.id} (explorer) failed`, body: "rate limited" },
    ]);

    await finish(second, "", "network down");

    expect(host.terminalNotices).toHaveLength(2);
    expect(host.terminalNotices[1]).toEqual({
      title: `pi-subagents: ${first.id} failed, ${second.id} failed`,
      body: "rate limited",
    });
  });

  it("notifies when an agent waits for an answer, once per dialog", async () => {
    const { run, host } = setup();
    const [child] = await run([{ agent: "explorer", task: "find auth" }]);
    const prompts = child.spec.prompts;

    await prompts?.confirm("Allow bash rm -rf build?", "The agent wants to run a command.");
    await prompts?.confirm("Allow write?", "Second question.");

    expect(host.terminalNotices).toEqual([
      {
        title: `pi-subagents: ${child.id} (explorer) needs input: Allow bash rm -rf build?`,
        body: "find auth",
      },
      { title: `pi-subagents: ${child.id} (explorer) needs input: Allow write?`, body: "find auth" },
    ]);
  });

  it("stays silent when a nested batch settles", async () => {
    const { run, finish, host, registry, runtime } = setup();
    const [parent] = await run([{ agent: "general", task: "investigate" }]);
    const runAgent = parent.spec.customTools?.find(
      (tool) => tool.name === "run_agent",
    ) as unknown as ToolSpec<RunAgentParams, unknown>;

    await runAgent.execute({ agents: [{ agent: "explorer", task: "look" }] }, { update: () => {} });
    await flush();

    const nested = registry.list().find((record) => record.callerId === parent.id);

    await finish(runtime.child(nested?.id as string), "Found it.");

    expect(host.terminalNotices).toEqual([]);

    await finish(parent, "Waiting for the explorer.");
    await finish(parent, "Fixed.");

    expect(host.terminalNotices).toEqual([{ title: `pi-subagents: ${parent.id} done`, body: "Fixed." }]);
  });

  it("stays silent with notifications off and while the session shuts down", async () => {
    const off = setup({ notifications: false });
    const [quiet] = await off.run([{ agent: "explorer", task: "find auth" }]);

    await off.finish(quiet, "", "boom");

    const shutting = setup();

    await shutting.run([{ agent: "explorer", task: "find auth" }]);
    await shutting.host.shutdown();

    expect(off.host.terminalNotices).toEqual([]);
    expect(shutting.registry.list()[0].state).toBe("failed");
    expect(shutting.host.terminalNotices).toEqual([]);
  });

  it("stays silent during shutdown with the shipped plugin list, whatever the order", async () => {
    const shipped = setup({}, plugins);
    const reversed = setup({}, plugins.toReversed());

    await shipped.run([{ agent: "explorer", task: "find auth" }]);
    await reversed.run([{ agent: "explorer", task: "find auth" }]);
    await shipped.host.shutdown();
    await reversed.host.shutdown();

    expect(shipped.host.terminalNotices).toEqual([]);
    expect(reversed.host.terminalNotices).toEqual([]);
  });
});
