import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { MANIFEST_FILE } from "../../../src/model/paths.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import {
  type AgentStatusDetails,
  type AgentStatusParams,
  agentStatusPlugin,
} from "../../../src/plugins/agent-status/index.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

const handoffText = (status: string) =>
  [
    "## Status",
    status,
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

const setup = async (overrides = {}, agent = "explorer") => {
  const harness = createHarness(
    [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin, agentStatusPlugin],
    overrides,
  );

  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;

  await harness.host
    .tool<RunAgentParams, unknown>("run_agent")
    .execute({ agents: [{ agent, task: "map the auth flow" }] }, { update: () => {} });
  await flush();
  harness.host.settle();

  const first = registry.list()[0];
  const current = (id: string) => registry.get(id) as AgentRecord;

  const requestHandoff = async (id: string) => {
    harness.runtime
      .child(id)
      .turn({ tokens: current(id).contextLimit + 500, window: 1_000_000, percent: 20 });
    await flush();
  };

  const writeHandoff = (id: string, status: string) => {
    mkdirSync(dirname(current(id).handoffPath), { recursive: true });
    writeFileSync(current(id).handoffPath, handoffText(status));
  };

  const handOff = async (id: string, status = "partial") => {
    await requestHandoff(id);
    writeHandoff(id, status);
    harness.runtime.child(id).finish(current(id).handoffPath);
    await flush();

    return current(id).successorId;
  };

  return { ...harness, registry, runner, first, current, requestHandoff, writeHandoff, handOff };
};

const manifestOf = (record: AgentRecord) => JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8"));

describe("successor chain", () => {
  it("continues a partial handoff in the same batch slot and wakes the caller once after the last link", async () => {
    const { first, current, handOff, runtime, host } = await setup({ maxChainLength: 3 });

    runtime.child(first.id).emit({ type: "tool_start", toolName: "grep" });

    const second = (await handOff(first.id)) as string;

    expect(current(first.id)).toMatchObject({ state: "handoff", successorId: second });
    expect(current(second)).toMatchObject({
      state: "running",
      chainIndex: 2,
      predecessorId: first.id,
      callerId: first.callerId,
      batchId: first.batchId,
    });
    expect(host.sent).toEqual([]);

    const task = runtime.child(second).task ?? "";

    expect(task).toContain(`continue the work of agent ${first.id} as link 2`);
    expect(task).toContain(`Read the handoff file at ${first.handoffPath} first`);
    expect(task).toContain("Original task:\nmap the auth flow");
    expect(task).toContain(`Input files:\n- ${first.handoffPath}`);

    runtime.child(second).emit({ type: "tool_start", toolName: "read" });

    const third = (await handOff(second)) as string;

    expect(current(third)).toMatchObject({ state: "running", chainIndex: 3, predecessorId: second });
    expect(runtime.child(third).messages).toEqual([]);
    expect(host.sent).toEqual([]);

    runtime.child(third).emit({ type: "tool_start", toolName: "read" });
    runtime.child(third).finish("final answer: tokens refresh in src/auth.ts");
    await flush();

    expect(host.sent).toHaveLength(1);

    const wake = host.sent[0];

    expect(wake).toContain("finished: 1 done.");
    expect(wake).toContain(`## ${third} (explorer) - done`);
    expect(wake).toContain(`Chain: ${first.id} → ${second} → ${third} (3 sessions)`);
    expect(wake).toContain("Done (3 tool calls");
    expect(wake).toContain("final answer: tokens refresh in src/auth.ts");
    expect(wake).not.toContain(`## ${first.id}`);
    expect(wake).not.toContain(`## ${second}`);
  });

  it("keeps the successor running when its predecessor closes", async () => {
    const { first, current, handOff, runtime } = await setup();
    const second = (await handOff(first.id)) as string;

    await flush();

    expect(current(second).state).toBe("running");
    expect(runtime.child(second).aborted).toBe(false);
  });

  it("links predecessor and successor in both manifests", async () => {
    const { first, current, handOff } = await setup();
    const second = (await handOff(first.id)) as string;

    expect(manifestOf(current(first.id))).toMatchObject({
      chainIndex: 1,
      successorId: second,
      state: "handoff",
    });
    expect(manifestOf(current(second))).toMatchObject({ chainIndex: 2, predecessorId: first.id });
  });

  it("closes a link as handoff without a successor when the handoff says done", async () => {
    const { first, current, handOff, registry } = await setup();

    expect(await handOff(first.id, "done")).toBeUndefined();
    expect(current(first.id).state).toBe("handoff");
    expect(current(first.id).error).toBe("Status must be one of partial, blocked");
    expect(registry.list()).toHaveLength(1);
  });

  it("closes as done without a handoff when the limit is crossed on the final answer turn", async () => {
    const { first, current, runtime, registry, host } = await setup();
    const child = runtime.child(first.id);

    child.turn({ tokens: first.contextLimit + 500, window: 1_000_000, percent: 20 }, "stop");
    await flush();
    child.finish("auth flow mapped");
    await flush();

    expect(child.messages).toEqual([]);
    expect(current(first.id)).toMatchObject({ state: "done", handoffRequested: false });
    expect(registry.list()).toHaveLength(1);
    expect(host.sent[0]).toContain("finished: 1 done.");
  });

  it("closes a link as handoff without a successor when the handoff says blocked", async () => {
    const { first, current, handOff, registry, host } = await setup();

    expect(await handOff(first.id, "blocked")).toBeUndefined();
    expect(current(first.id).state).toBe("handoff");
    expect(registry.list()).toHaveLength(1);
    expect(host.sent[0]).toContain(`Handoff file: ${first.handoffPath}`);
  });

  it("closes the last link as handoff when the chain length cap is reached", async () => {
    const { first, current, handOff, registry, host } = await setup({ maxChainLength: 2 });
    const second = (await handOff(first.id)) as string;

    expect(host.sent).toEqual([]);
    expect(await handOff(second)).toBeUndefined();
    expect(current(second).state).toBe("handoff");
    expect(registry.list()).toHaveLength(2);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toContain("finished: 1 handoff.");
    expect(host.sent[0]).toContain(`Chain: ${first.id} → ${second} (2 sessions)`);
    expect(host.sent[0]).toContain(`Handoff file: ${current(second).handoffPath}`);
  });

  it("never continues after a user stop during link 2 and wakes once", async () => {
    const { first, current, handOff, runner, registry, host } = await setup({ stopGraceSeconds: 0 });
    const second = (await handOff(first.id)) as string;

    expect(await runner.stop(first.id)).toBe(true);
    await flush();

    expect(current(second).state).toBe("stopped");
    expect(registry.list()).toHaveLength(2);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toContain("finished: 1 stopped.");
    expect(host.sent[0]).toContain(`Chain: ${first.id} → ${second} (2 sessions)`);
  });

  it("never continues when a partial handoff is written during the grace period", async () => {
    const { first, current, requestHandoff, writeHandoff, runner, runtime, registry, host } = await setup();

    await requestHandoff(first.id);
    await runner.stop(first.id);

    expect(current(first.id).state).toBe("grace");

    writeHandoff(first.id, "partial");
    runtime.child(first.id).finish("handoff written");
    await flush();

    expect(current(first.id).state).toBe("handoff");
    expect(registry.list()).toHaveLength(1);
    expect(host.sent).toHaveLength(1);

    await host.shutdown("quit");
  });

  it("never continues on shutdown", async () => {
    const { first, requestHandoff, writeHandoff, registry, host } = await setup();

    await requestHandoff(first.id);
    writeHandoff(first.id, "partial");
    await host.shutdown("reload");
    await flush();

    expect(registry.list()).toHaveLength(1);
    expect(registry.get(first.id)?.state).toBe("failed");
  });

  it("forwards route and stop with a predecessor id to the live successor", async () => {
    const { first, current, handOff, runner, runtime } = await setup({ stopGraceSeconds: 0 });
    const second = (await handOff(first.id)) as string;

    const routed = await runner.route(first.id, { sender: "main", text: "also check logout" });

    expect(routed).toEqual({ ok: true, delivery: "steer" });
    expect(runtime.child(second).messages.map((entry) => entry.message.text)).toEqual(["also check logout"]);
    expect(runtime.child(first.id).messages.map((entry) => entry.message.text)).not.toContain(
      "also check logout",
    );

    expect(await runner.stop(first.id)).toBe(true);
    expect(current(second).state).toBe("stopped");
    expect(await runner.stop(first.id)).toBe(false);
  });

  it("reports the terminal link in agent_status when asked with a predecessor id", async () => {
    const { first, handOff, host } = await setup();
    const second = (await handOff(first.id)) as string;
    const status = host.tool<AgentStatusParams, AgentStatusDetails>("agent_status");

    const byPredecessor = await status.execute({ ids: [first.id] }, { update: () => {} });

    expect(byPredecessor.details?.agents[0]).toMatchObject({
      id: second,
      requestedId: first.id,
      state: "running",
      chainIndex: 2,
      predecessorId: first.id,
    });
    expect(byPredecessor.text).toContain(`${first.id} → ${second} (explorer`);
    expect(byPredecessor.text).toContain(`chain: link 2, continues ${first.id}`);

    const all = await status.execute({}, { update: () => {} });

    expect(all.details?.agents.map((agent) => agent.id)).toEqual([second]);
  });

  it("gives the successor the batch results its predecessor had not received yet", async () => {
    const { first, current, requestHandoff, writeHandoff, runtime, registry } = await setup({}, "general");
    const child = runtime.child(first.id);
    const runAgent = child.spec.customTools?.find((tool) => tool.name === "run_agent");

    await runAgent?.execute({ agents: [{ agent: "explorer", task: "find the token store" }] } as never, {
      update: () => {},
    });
    await flush();

    const explorer = registry.list()[1];

    runtime.child(explorer.id).finish("the token store is src/store.ts");
    await flush();

    expect(child.wakes).toEqual([]);

    await requestHandoff(first.id);
    writeHandoff(first.id, "partial");
    child.finish(current(first.id).handoffPath);
    await flush();

    const successor = current(first.id).successorId as string;
    const task = runtime.child(successor).task ?? "";

    expect(task).toContain("Batch results that reached your predecessor after it stopped for the handoff:");
    expect(task).toContain(`Batch ${explorer.batchId} finished: 1 done.`);
    expect(task).toContain("the token store is src/store.ts");
  });

  it("resolves a waiting child caller once with the terminal records", async () => {
    const { first, current, handOff, runner, runtime } = await setup({}, "general");

    const started = runner.startBatch([{ agent: "explorer", task: "find the token store" }], {
      callerId: first.id,
      wait: true,
    });
    await flush();

    const [link] = started.records;
    let resolutions = 0;

    const settled = started.settled.then((records) => {
      resolutions += 1;
      return records;
    });

    const second = (await handOff(link.id)) as string;

    expect(resolutions).toBe(0);

    runtime.child(second).finish("token store is in src/store.ts");
    await flush();

    const records = await settled;

    expect(resolutions).toBe(1);
    expect(records.map((record) => record.id)).toEqual([second]);
    expect(records[0].state).toBe("done");
    expect(runner.batchText(started.batchId)).toContain(`Chain: ${link.id} → ${second} (2 sessions)`);
    expect(runtime.child(first.id).wakes).toEqual([]);
    expect(current(first.id).state).toBe("running");
  });
});
