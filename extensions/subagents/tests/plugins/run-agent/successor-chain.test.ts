import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnyToolSpec } from "../../../../../platform/pi-adapter/index.ts";
import { flushMicrotasks, hiddenMessageTexts } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { agentStatusPlugin } from "../../../api/plugins/agent-status.ts";
import { limitsPlugin } from "../../../api/plugins/limits.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { AgentStatusDetails, AgentStatusParams } from "../../../core/agent-status/snapshot.ts";
import type { AgentRecord } from "../../../core/model/agent-record.ts";
import { MANIFEST_FILE } from "../../../core/model/paths.ts";
import type { Runner } from "../../../core/run-agent/runner.ts";
import type { RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

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

const BLIND_AGENT = [
  "---",
  "name: blind",
  "description: Test agent that cannot read files.",
  "limit: 100000",
  "tools: [grep]",
  "skills: all",
  "subagents: []",
  "---",
  "Search without reading.",
].join("\n");

const setup = async (overrides = {}, agent = "scout") => {
  const harness = createHarness(
    [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin, agentStatusPlugin],
    { overrides },
  );

  if (agent === "blind") {
    const userAgentsDir = join(harness.host.info.agentDir, "agents");

    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(join(userAgentsDir, "blind.md"), BLIND_AGENT);
    harness.host.start();
  }

  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;

  await harness.host
    .tool<RunAgentParams, unknown>("run_agent")
    .execute({ agents: [{ agent, task: "map the auth flow" }] }, { update: () => {} });
  await flushMicrotasks();
  harness.host.settle();

  const first = registry.list()[0];
  const current = (id: string) => registry.get(id) as AgentRecord;

  const requestHandoff = async (id: string) => {
    harness.runtime
      .child(id)
      .turn({ tokens: current(id).contextLimit + 500, window: 1_000_000, percent: 20 });
    await flushMicrotasks();
  };

  const writeHandoff = (id: string, status: string) => {
    mkdirSync(dirname(current(id).handoffPath), { recursive: true });
    writeFileSync(current(id).handoffPath, handoffText(status));
  };

  const handOff = async (id: string, status = "partial") => {
    await requestHandoff(id);
    writeHandoff(id, status);
    harness.runtime.child(id).finish(current(id).handoffPath);
    await flushMicrotasks();

    return current(id).successorId;
  };

  return { ...harness, registry, runner, first, current, requestHandoff, writeHandoff, handOff };
};

const handoffToolOf = (child: { spec: { customTools?: AnyToolSpec[] } }) =>
  child.spec.customTools?.find((tool) => tool.name === "handoff") as AnyToolSpec;

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
    expect(hiddenMessageTexts(host)).toEqual([]);

    const task = runtime.child(second).task ?? "";
    const seed = runtime.child(second).seed;

    expect(seed).toMatchObject({
      customType: "pi-handoff-seed",
      details: { from: "agent", id: first.id, link: 2 },
    });
    expect(seed?.text).toContain(`continue the work of agent ${first.id} as link 2`);
    expect(seed?.text).toContain(first.handoffPath);
    expect(seed?.text).toContain("- trace token refresh");
    expect(task).toContain("Original task:\nmap the auth flow");
    expect(task).not.toContain("Input files");
    expect(task).not.toContain(first.handoffPath);

    runtime.child(second).emit({ type: "tool_start", toolName: "read" });

    const third = (await handOff(second)) as string;

    expect(current(third)).toMatchObject({ state: "running", chainIndex: 3, predecessorId: second });
    expect(runtime.child(third).seed?.details).toEqual({ from: "agent", id: second, link: 3 });
    expect(runtime.child(third).seed?.text).toContain(`agent ${second} as link 3`);
    expect(runtime.child(third).messages).toEqual([]);
    expect(hiddenMessageTexts(host)).toEqual([]);

    runtime.child(third).emit({ type: "tool_start", toolName: "read" });
    runtime.child(third).finish("final answer: tokens refresh in src/auth.ts");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(1);

    const wake = hiddenMessageTexts(host)[0];

    expect(wake).toContain("finished: 1 done.");
    expect(wake).toContain(`## ${third} (scout) - done`);
    expect(wake).toContain(`Chain: ${first.id} → ${second} → ${third} (3 sessions)`);
    expect(wake).toContain("\nDone · 0s · 3 calls\n");
    expect(wake).toContain("final answer: tokens refresh in src/auth.ts");
    expect(wake).not.toContain(`## ${first.id}`);
    expect(wake).not.toContain(`## ${second}`);
  });

  it("keeps the successor running when its predecessor closes", async () => {
    const { first, current, handOff, runtime } = await setup();
    const second = (await handOff(first.id)) as string;

    await flushMicrotasks();

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

  it("continues the chain from a handoff given as the final reply when no file was written", async () => {
    const { first, current, requestHandoff, runtime, registry } = await setup({ maxChainLength: 3 });

    await requestHandoff(first.id);

    expect(existsSync(first.handoffPath)).toBe(false);

    runtime.child(first.id).finish(handoffText("partial"));
    await flushMicrotasks();

    const second = current(first.id).successorId as string;

    expect(current(first.id)).toMatchObject({ state: "handoff", resultText: handoffText("partial") });
    expect(current(second)).toMatchObject({ state: "running", chainIndex: 2, predecessorId: first.id });
    expect(readFileSync(first.handoffPath, "utf8")).toBe(`${handoffText("partial")}\n`);
    expect(runtime.child(second).seed?.text).toContain("- trace token refresh");
    expect(runtime.child(second).task).not.toContain("Input files");
    expect(registry.list()).toHaveLength(2);
  });

  it("gives a read-only agent the handoff tool, which refuses before a handoff is requested", async () => {
    const { first, runtime } = await setup();
    const child = runtime.child(first.id);

    expect(child.spec.tools).not.toContain("write");
    expect(child.spec.tools).not.toContain("bash");

    const result = await handoffToolOf(child).execute({ content: handoffText("partial") } as never, {
      update: () => {},
    });

    expect(result).toMatchObject({
      text: "Error: no handoff was requested; continue your task.",
      isError: true,
    });
    expect(existsSync(first.handoffPath)).toBe(false);
  });

  it("continues the chain from a handoff saved with the handoff tool", async () => {
    const { first, current, requestHandoff, runtime, registry } = await setup({ maxChainLength: 3 });
    const child = runtime.child(first.id);

    await requestHandoff(first.id);

    const result = await handoffToolOf(child).execute({ content: handoffText("partial") } as never, {
      update: () => {},
    });

    expect(result).toEqual({ text: `Handoff saved at ${first.handoffPath}` });
    expect(readFileSync(first.handoffPath, "utf8")).toBe(`${handoffText("partial")}\n`);

    child.finish("handoff saved");
    await flushMicrotasks();

    const second = current(first.id).successorId as string;

    expect(current(first.id)).toMatchObject({ state: "handoff", resultText: `${handoffText("partial")}\n` });
    expect(current(second)).toMatchObject({ state: "running", chainIndex: 2, predecessorId: first.id });
    expect(runtime.child(second).seed?.text).toContain("- trace token refresh");
    expect(runtime.child(second).task).not.toContain("Input files");
    expect(registry.list()).toHaveLength(2);
  });

  it("hands a successor of an agent without the read tool its predecessor's handoff inline", async () => {
    const { first, handOff, runtime } = await setup({ maxChainLength: 3 }, "blind");
    const second = (await handOff(first.id)) as string;

    expect(runtime.child(first.id).spec.tools).not.toContain("read");
    expect(runtime.child(second).seed?.text).toContain("- trace token refresh");
  });

  it("saves an invalid handoff from the tool and returns its errors", async () => {
    const { first, current, requestHandoff, runtime, registry } = await setup();
    const child = runtime.child(first.id);
    const invalid = "## Status\npartial\n## Outcome\nx";

    await requestHandoff(first.id);

    const result = await handoffToolOf(child).execute({ content: invalid } as never, { update: () => {} });

    expect(result).toEqual({
      text: `Handoff saved at ${first.handoffPath} but it is invalid: missing sections: Evidence, Blocker, Next, Files touched. Fix the sections and call handoff again.`,
      isError: true,
    });
    expect(readFileSync(first.handoffPath, "utf8")).toBe(`${invalid}\n`);

    child.finish("handoff saved");
    await flushMicrotasks();

    expect(current(first.id)).toMatchObject({
      state: "handoff",
      error: "missing sections: Evidence, Blocker, Next, Files touched",
    });
    expect(registry.list()).toHaveLength(1);
  });

  it("closes as handoff from a blocked handoff given as the final reply", async () => {
    const { first, current, requestHandoff, runtime, registry, host } = await setup();

    await requestHandoff(first.id);
    runtime.child(first.id).finish(handoffText("blocked"));
    await flushMicrotasks();

    expect(current(first.id).state).toBe("handoff");
    expect(current(first.id).error).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain(`Handoff file: ${first.handoffPath}`);
  });

  it("fails when no file was written and the final reply is not a handoff", async () => {
    const { first, current, requestHandoff, runtime, registry } = await setup();

    await requestHandoff(first.id);
    runtime.child(first.id).finish("I could not find a tool to write the file.");
    await flushMicrotasks();

    expect(current(first.id)).toMatchObject({
      state: "failed",
      error: `context limit reached but no handoff file was written at ${first.handoffPath} and the final reply is not a handoff`,
    });
    expect(existsSync(first.handoffPath)).toBe(false);
    expect(registry.list()).toHaveLength(1);
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
    await flushMicrotasks();
    child.finish("auth flow mapped");
    await flushMicrotasks();

    expect(child.messages).toEqual([]);
    expect(current(first.id)).toMatchObject({ state: "done", handoffRequested: false });
    expect(registry.list()).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("finished: 1 done.");
  });

  it("closes a link as handoff without a successor when the handoff says blocked", async () => {
    const { first, current, handOff, registry, host } = await setup();

    expect(await handOff(first.id, "blocked")).toBeUndefined();
    expect(current(first.id).state).toBe("handoff");
    expect(registry.list()).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain(`Handoff file: ${first.handoffPath}`);
  });

  it("closes the last link as handoff when the chain length cap is reached", async () => {
    const { first, current, handOff, registry, host } = await setup({ maxChainLength: 2 });
    const second = (await handOff(first.id)) as string;

    expect(hiddenMessageTexts(host)).toEqual([]);
    expect(await handOff(second)).toBeUndefined();
    expect(current(second).state).toBe("handoff");
    expect(registry.list()).toHaveLength(2);
    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("finished: 1 handoff.");
    expect(hiddenMessageTexts(host)[0]).toContain(`Chain: ${first.id} → ${second} (2 sessions)`);
    expect(hiddenMessageTexts(host)[0]).toContain(`Handoff file: ${current(second).handoffPath}`);
    expect(host.hidden.map((entry) => entry.message.customType)).toEqual(["pi-subagents:wake"]);
    expect(hiddenMessageTexts(host)[0].split("\n\n---\n\n")).toHaveLength(1);
  });

  it("never continues after a user stop during link 2 and wakes once", async () => {
    const { first, current, handOff, runner, registry, host } = await setup({ stopGraceSeconds: 0 });
    const second = (await handOff(first.id)) as string;

    expect(await runner.stop(first.id)).toBe(true);
    await flushMicrotasks();

    expect(current(second).state).toBe("stopped");
    expect(registry.list()).toHaveLength(2);
    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("finished: 1 stopped.");
    expect(hiddenMessageTexts(host)[0]).toContain(`Chain: ${first.id} → ${second} (2 sessions)`);
  });

  it("never continues when a partial handoff is written during the grace period", async () => {
    const { first, current, requestHandoff, writeHandoff, runner, runtime, registry, host } = await setup();

    await requestHandoff(first.id);
    await runner.stop(first.id);

    expect(current(first.id).state).toBe("grace");

    writeHandoff(first.id, "partial");
    runtime.child(first.id).finish("handoff written");
    await flushMicrotasks();

    expect(current(first.id).state).toBe("handoff");
    expect(registry.list()).toHaveLength(1);
    expect(hiddenMessageTexts(host)).toHaveLength(1);

    await host.shutdown("quit");
  });

  it("closes as handoff when a partial handoff is replied during the grace period", async () => {
    const { first, current, requestHandoff, runner, runtime, registry } = await setup();

    await requestHandoff(first.id);
    await runner.stop(first.id);
    runtime.child(first.id).finish(handoffText("partial"));
    await flushMicrotasks();

    expect(current(first.id).state).toBe("handoff");
    expect(readFileSync(first.handoffPath, "utf8")).toBe(`${handoffText("partial")}\n`);
    expect(registry.list()).toHaveLength(1);
  });

  it("never continues on shutdown", async () => {
    const { first, requestHandoff, writeHandoff, registry, host } = await setup();

    await requestHandoff(first.id);
    writeHandoff(first.id, "partial");
    await host.shutdown("reload");
    await flushMicrotasks();

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
    expect(byPredecessor.text).toContain(`${first.id} → ${second} (scout`);
    expect(byPredecessor.text).toContain(`chain: link 2, continues ${first.id}`);

    const all = await status.execute({}, { update: () => {} });

    expect(all.details?.agents.map((agent) => agent.id)).toEqual([second]);
  });

  it("gives the successor the batch results its predecessor had not received yet", async () => {
    const { first, current, requestHandoff, writeHandoff, runtime, registry } = await setup({}, "general");
    const child = runtime.child(first.id);
    const runAgent = child.spec.customTools?.find((tool) => tool.name === "run_agent");

    await runAgent?.execute({ agents: [{ agent: "scout", task: "find the token store" }] } as never, {
      update: () => {},
    });
    await flushMicrotasks();

    const scout = registry.list()[1];

    runtime.child(scout.id).finish("the token store is src/store.ts");
    await flushMicrotasks();

    expect(child.wakes).toEqual([]);

    await requestHandoff(first.id);
    writeHandoff(first.id, "partial");
    child.finish(current(first.id).handoffPath);
    await flushMicrotasks();

    const successor = current(first.id).successorId as string;
    const task = runtime.child(successor).task ?? "";

    expect(task).toContain("Batch results that reached your predecessor after it stopped for the handoff:");
    expect(task).toContain(`Batch ${scout.batchId} finished: 1 done.`);
    expect(task).toContain("the token store is src/store.ts");
  });

  it("wakes a child caller once with the chain's terminal result", async () => {
    const { first, handOff, runner, runtime } = await setup({}, "general");
    const caller = runtime.child(first.id);

    const started = runner.startBatch([{ agent: "scout", task: "find the token store" }], {
      callerId: first.id,
    });
    await flushMicrotasks();
    caller.finish("Started batch, waiting.");
    await flushMicrotasks();

    const [link] = started.records;
    const second = (await handOff(link.id)) as string;

    expect(caller.wakes).toEqual([]);

    runtime.child(second).finish("token store is in src/store.ts");
    await flushMicrotasks();

    expect(caller.wakes).toHaveLength(1);
    expect(caller.wakes[0]).toContain(`Chain: ${link.id} → ${second} (2 sessions)`);
    expect(caller.wakes[0]).toContain("token store is in src/store.ts");
  });
});
