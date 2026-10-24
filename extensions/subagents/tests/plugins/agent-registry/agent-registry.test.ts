import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSY_CHANNEL } from "../../../../../shared/index.ts";
import { createFakeHost, flushMicrotasks } from "../../../../../test-framework/index.ts";
import { type AgentRecord, MAIN_CALLER } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import {
  type AgentStatusDetails,
  type AgentStatusParams,
  agentStatusPlugin,
} from "../../../src/plugins/agent-status/index.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import { createHarness, startPlugins } from "../../support/subagents-harness.ts";

const HANDOFF = [
  "## Status",
  "partial",
  "",
  "## Outcome",
  "- auth handler located in src/auth.ts",
  "",
  "## Evidence",
  "- grep for handleLogin: src/auth.ts:42",
  "",
  "## Blocker",
  "none",
  "",
  "## Next",
  "- trace token refresh",
  "",
  "## Files touched",
  "none",
].join("\n");

const busySignals = (published: { channel: string; data: unknown }[]) =>
  published.filter((entry) => entry.channel === BUSY_CHANNEL).map((entry) => entry.data);

const setup = () => {
  const harness = createHarness([agentRegistryPlugin]);
  const registry = harness.services.require("registry");

  const open = () =>
    registry.create({
      agent: "scout",
      description: "search",
      callerId: MAIN_CALLER,
      depth: 1,
      batchId: "batch-1",
      dir: join(harness.root, "agents"),
      contextLimit: 100_000,
    });

  const signals = () => busySignals(harness.host.published);

  return { ...harness, registry, open, signals };
};

const setupRunning = async (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin], {
    overrides,
  });

  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;

  await harness.host
    .tool<RunAgentParams, unknown>("run_agent")
    .execute({ agents: [{ agent: "scout", task: "map the auth flow" }] }, { update: () => {} });
  await flushMicrotasks();
  harness.host.settle();

  const signals = () => busySignals(harness.host.published);
  const last = () => signals().at(-1);
  const first = registry.list()[0];
  const current = (id: string) => registry.get(id) as AgentRecord;

  return { ...harness, registry, runner, signals, last, first, current };
};

describe("busy signal", () => {
  it("reports idle on session start", () => {
    const { signals } = setup();

    expect(signals()).toEqual([{ source: "pi-subagents", busy: false }]);
  });

  it("reports busy when the first agent opens and idle when the last one closes", () => {
    const { registry, open, signals } = setup();
    const first = open();
    const second = open();

    registry.update(first.id, { state: "running" });
    registry.close(first.id, { state: "done" });

    expect(signals()).toEqual([
      { source: "pi-subagents", busy: false },
      { source: "pi-subagents", busy: true },
    ]);

    registry.close(second.id, { state: "failed" });

    expect(signals()).toEqual([
      { source: "pi-subagents", busy: false },
      { source: "pi-subagents", busy: true },
      { source: "pi-subagents", busy: false },
    ]);
  });

  it("reports idle when shutdown closes the running agents", async () => {
    const { host, last } = await setupRunning();

    expect(last()).toEqual({ source: "pi-subagents", busy: true });

    await host.shutdown("new");

    expect(last()).toEqual({ source: "pi-subagents", busy: false });
  });

  it("reports idle when a stop closes the agent", async () => {
    const { runner, first, last, current } = await setupRunning({ stopGraceSeconds: 0 });

    expect(last()).toEqual({ source: "pi-subagents", busy: true });

    await runner.stop(first.id);
    await flushMicrotasks();

    expect(current(first.id).state).toBe("stopped");
    expect(last()).toEqual({ source: "pi-subagents", busy: false });
  });

  it("stays busy while the successor of a chain handoff runs", async () => {
    const { runtime, first, last, current } = await setupRunning({ maxChainLength: 3 });

    runtime
      .child(first.id)
      .turn({ tokens: current(first.id).contextLimit + 500, window: 1_000_000, percent: 20 });
    await flushMicrotasks();
    mkdirSync(dirname(current(first.id).handoffPath), { recursive: true });
    writeFileSync(current(first.id).handoffPath, HANDOFF);
    runtime.child(first.id).finish(current(first.id).handoffPath);
    await flushMicrotasks();

    const successor = current(first.id).successorId as string;

    expect(current(first.id).state).toBe("handoff");
    expect(current(successor).state).toBe("running");
    expect(last()).toEqual({ source: "pi-subagents", busy: true });
  });
});

describe("reload", () => {
  const plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentStatusPlugin];

  const reload = async (harness: ReturnType<typeof createHarness>) => {
    await harness.host.shutdown("reload");

    return startPlugins(createFakeHost(harness.host.info), harness.runtime, plugins);
  };

  const statusText = async (next: Awaited<ReturnType<typeof reload>>) => {
    const result = await next.host
      .tool<AgentStatusParams, AgentStatusDetails>("agent_status")
      .execute({}, { update: () => {} });

    return JSON.stringify(result);
  };

  it("keeps finished agents with their final state", async () => {
    const harness = createHarness(plugins);

    await harness.host.tool<RunAgentParams, unknown>("run_agent").execute(
      {
        agents: [
          { agent: "scout", task: "map the auth flow" },
          { agent: "scout", task: "map the billing flow" },
        ],
      },
      { update: () => {} },
    );
    await flushMicrotasks();
    harness.host.settle();

    const [done, failed] = harness.services.require("registry").list();

    harness.runtime.child(done.id).finish("Status: done\nauth mapped");
    harness.runtime.child(failed.id).finish("", { stopReason: "error", error: "rate limited" });
    await flushMicrotasks();

    const next = await reload(harness);
    const registry = next.services.require("registry");

    expect(registry.list().map((record) => [record.id, record.state, record.description])).toEqual(
      expect.arrayContaining([
        [done.id, "done", done.description],
        [failed.id, "failed", failed.description],
      ]),
    );
    expect(registry.list()).toHaveLength(2);
    expect(await statusText(next)).toContain(`${done.id} (scout, ${done.model}) done`);
  });

  it("lists an agent cut off by the reload as failed", async () => {
    const harness = createHarness(plugins);

    await harness.host
      .tool<RunAgentParams, unknown>("run_agent")
      .execute({ agents: [{ agent: "scout", task: "map the auth flow" }] }, { update: () => {} });
    await flushMicrotasks();
    harness.host.settle();

    const [record] = harness.services.require("registry").list();
    const next = await reload(harness);
    const restored = next.services.require("registry").get(record.id);

    expect(restored?.state).toBe("failed");
    expect(busySignals(next.host.published)).toEqual([{ source: "pi-subagents", busy: false }]);
  });
});
