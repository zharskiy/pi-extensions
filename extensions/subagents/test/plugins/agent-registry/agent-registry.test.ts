import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSY_CHANNEL } from "../../../../../core/manager/channels.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { type AgentRecord, MAIN_CALLER } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import { createHarness } from "../../helpers/harness.ts";

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
      agent: "explorer",
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
  const harness = createHarness(
    [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin],
    overrides,
  );

  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;

  await harness.host
    .tool<RunAgentParams, unknown>("run_agent")
    .execute({ agents: [{ agent: "explorer", task: "map the auth flow" }] }, { update: () => {} });
  await flush();
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
    await flush();

    expect(current(first.id).state).toBe("stopped");
    expect(last()).toEqual({ source: "pi-subagents", busy: false });
  });

  it("stays busy while the successor of a chain handoff runs", async () => {
    const { runtime, first, last, current } = await setupRunning({ maxChainLength: 3 });

    runtime
      .child(first.id)
      .turn({ tokens: current(first.id).contextLimit + 500, window: 1_000_000, percent: 20 });
    await flush();
    mkdirSync(dirname(current(first.id).handoffPath), { recursive: true });
    writeFileSync(current(first.id).handoffPath, HANDOFF);
    runtime.child(first.id).finish(current(first.id).handoffPath);
    await flush();

    const successor = current(first.id).successorId as string;

    expect(current(first.id).state).toBe("handoff");
    expect(current(successor).state).toBe("running");
    expect(last()).toEqual({ source: "pi-subagents", busy: true });
  });
});
