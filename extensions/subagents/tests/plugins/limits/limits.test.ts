import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StopReason, ToolSpec } from "../../../../../platform/pi-adapter/index.ts";
import { flushMicrotasks, hiddenMessageTexts, VALID_HANDOFF } from "../../../../../test/framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { limitsPlugin } from "../../../api/plugins/limits.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const WIDE_AGENT = [
  "---",
  "name: wide",
  "description: Test agent with a limit larger than any model window.",
  "limit: 1000000",
  "tools: all",
  "skills: all",
  "subagents: []",
  "---",
  "Search wide.",
].join("\n");

const setup = async (overrides = {}, agent = "scout") => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin], {
    overrides,
  });

  if (agent === "wide") {
    const userAgentsDir = join(harness.host.info.agentDir, "agents");

    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(join(userAgentsDir, "wide.md"), WIDE_AGENT);
    harness.host.start();
  }

  await harness.host
    .tool<RunAgentParams, unknown>("run_agent")
    .execute({ agents: [{ agent, task: "huge repo" }] }, { update: () => {} });
  await flushMicrotasks();
  harness.host.settle();

  const record = harness.services.require("registry").list()[0];
  const child = harness.runtime.child(record.id);

  const turn = async (tokens: number, stopReason: StopReason = "toolUse", toolCalls?: number) => {
    child.turn({ tokens, window: 400_000, percent: (tokens / 400_000) * 100 }, stopReason, toolCalls);
    await flushMicrotasks();
  };

  return { ...harness, record, child, turn };
};

describe("limits plugin", () => {
  it("triggers the warning and the handoff on the turns that cross the lines, through the message route", async () => {
    const { child, turn, record, services } = await setup();

    await turn(50_000);

    expect(child.messages).toEqual([]);

    await turn(81_000);

    expect(child.messages).toHaveLength(1);
    expect(child.messages[0].message).toMatchObject({ sender: "pi-subagents" });
    expect(child.messages[0].message.text).toContain("Context limit warning");
    expect(child.messages[0].delivery).toBe("steer");

    await turn(90_000);

    expect(child.messages).toHaveLength(1);

    await turn(100_500);

    expect(child.messages).toHaveLength(2);
    expect(child.messages[1].message.text).toContain(record.handoffPath);
    expect(child.messages[1].message.text).toContain("## Files touched");
    expect(child.messages[1].message).toMatchObject({
      customType: "pi-handoff-request",
      details: { reason: "limit", tokens: 100_500, request: 100_000 },
    });
    expect(child.messages[1].delivery).toBe("steer");
    expect(child.messages[0].message).not.toHaveProperty("customType");
    expect(services.require("registry").get(record.id)?.handoffRequested).toBe(true);
  });

  it("delivers the handoff request as the same custom message to an agent that was held in the queue", async () => {
    const { host, runtime, services } = await setup({ maxConcurrent: 1 });
    const registry = services.require("registry");
    const runner = services.require("runner");

    await host
      .tool<RunAgentParams, unknown>("run_agent")
      .execute({ agents: [{ agent: "scout", task: "second" }] }, { update: () => {} });
    await flushMicrotasks();

    const queued = registry.list()[1];
    const request = { customType: "pi-handoff-request", text: "hand off" };

    await runner.route(queued.id, request);

    expect(runtime.children).toHaveLength(1);

    runtime.child(registry.list()[0].id).finish("done");
    await flushMicrotasks();

    expect(runtime.child(queued.id).messages.map((entry) => entry.message)).toEqual([request]);
  });

  it("draws the request and seed rows with only the subagents extension booted", async () => {
    const { host } = await setup();

    expect(
      host.renderMessage("pi-handoff-request", {
        text: "x",
        details: { reason: "limit", tokens: 176_000, request: 175_000 },
      })[0],
    ).toBe("» handoff requested · 176k of 175k tokens (<app.tools.expand> to expand)");
    expect(
      host.renderMessage("pi-handoff-seed", {
        text: "Carry on. More.",
        details: { from: "agent", id: "a3", link: 2 },
      })[0],
    ).toBe("» handoff from agent a3 · link 2");
  });

  it("closes the agent as handoff and wakes the caller with the file path when the handoff is valid", async () => {
    const { child, turn, record, host, services } = await setup({ maxChainLength: 1 });

    await turn(100_500);

    mkdirSync(dirname(record.handoffPath), { recursive: true });
    writeFileSync(record.handoffPath, VALID_HANDOFF);
    child.finish(record.handoffPath);
    await flushMicrotasks();

    expect(services.require("registry").get(record.id)?.state).toBe("handoff");
    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain(`Handoff file: ${record.handoffPath}`);
  });

  it("closes the agent as handoff with the validation errors when the handoff file is invalid", async () => {
    const { child, turn, record, services, host } = await setup();

    await turn(100_500);

    mkdirSync(dirname(record.handoffPath), { recursive: true });
    writeFileSync(record.handoffPath, VALID_HANDOFF.replace("partial", "done"));
    child.finish("wrote it");
    await flushMicrotasks();

    const closed = services.require("registry").get(record.id);

    expect(closed).toMatchObject({
      state: "handoff",
      error: "Status must be one of partial, blocked",
      resultText: VALID_HANDOFF.replace("partial", "done"),
    });
    expect(closed?.successorId).toBeUndefined();
    expect(hiddenMessageTexts(host)[0]).toContain(
      `Handoff file: ${record.handoffPath} (invalid: Status must be one of partial, blocked)`,
    );
  });

  it("fails the agent when the handoff file is missing and the final reply is not a handoff", async () => {
    const { child, turn, record, services } = await setup();

    await turn(100_500);
    child.finish("wrote it");

    const closed = services.require("registry").get(record.id);

    expect(closed?.state).toBe("failed");
    expect(closed?.error).toBe(
      `context limit reached but no handoff file was written at ${record.handoffPath} and the final reply is not a handoff`,
    );
  });

  it("aborts an agent that keeps going past the hard line after its grace turn", async () => {
    const { child, turn, record, services } = await setup();

    await turn(100_500);
    await turn(116_000);

    expect(child.aborted).toBe(false);

    await turn(117_000);

    expect(child.aborted).toBe(true);
    expect(services.require("registry").get(record.id)?.error).toBe(
      `context limit reached but no handoff file was written at ${record.handoffPath} and the final reply is not a handoff`,
    );
  });

  it("leaves a turn that ends with the final answer alone and lets the agent close as done", async () => {
    const { child, turn, record, services } = await setup();

    await turn(81_000, "stop");
    await turn(100_500, "stop");

    expect(child.messages).toEqual([]);

    child.finish("auth flow mapped");

    expect(services.require("registry").get(record.id)).toMatchObject({
      state: "done",
      handoffRequested: false,
    });
  });

  it("sends the warning and the handoff only on turns that continue with tool calls", async () => {
    const { child, turn, record } = await setup();

    await turn(81_000, "stop");

    expect(child.messages).toEqual([]);

    await turn(82_000);

    expect(child.messages.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Context limit warning"),
    ]);

    await turn(100_500, "stop");

    expect(child.messages).toHaveLength(1);

    await turn(100_600);

    expect(child.messages).toHaveLength(2);
    expect(child.messages[1].message.text).toContain(record.handoffPath);
  });

  it("counts a turn as continuing from its tool calls, not from the stop reason", async () => {
    const { child, turn } = await setup();

    await turn(81_000, "toolUse", 0);
    await turn(81_500, "error", 1);
    await turn(81_800, "aborted", 1);

    expect(child.messages).toEqual([]);

    await turn(82_000, "length", 1);

    expect(child.messages.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Context limit warning"),
    ]);
  });

  it("requests the handoff on the next continuing wake turn of an agent over its limit waiting on its own batch", async () => {
    const { child, turn, record, runtime, services } = await setup({}, "general");
    const registry = services.require("registry");
    const runChild = child.spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as ToolSpec<
      RunAgentParams,
      unknown
    >;

    await runChild.execute({ agents: [{ agent: "scout", task: "look" }] }, { update: () => {} });
    await flushMicrotasks();
    await turn(100_500, "stop");
    child.finish("Started batch, waiting.");
    await flushMicrotasks();

    expect(registry.get(record.id)).toMatchObject({ state: "running", handoffRequested: false });
    expect(child.messages).toEqual([]);

    runtime.child(registry.list()[1].id).finish("found it in src/a.ts");
    await flushMicrotasks();

    expect(child.wakes).toHaveLength(1);

    await turn(101_000);

    expect(registry.get(record.id)?.handoffRequested).toBe(true);
    expect(child.messages.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining(record.handoffPath),
    ]);
  });

  it("does not abort an agent past the hard line on the turn that replies with the handoff path", async () => {
    const { child, turn } = await setup();

    await turn(100_500);
    await turn(116_000, "stop");

    expect(child.aborted).toBe(false);
  });

  it("aborts an agent that keeps working three turns after the handoff request", async () => {
    const { child, turn, record, services } = await setup();

    await turn(100_500);
    await turn(101_000);
    await turn(101_000);

    expect(child.aborted).toBe(false);

    await turn(101_000);

    expect(child.aborted).toBe(true);
    expect(services.require("registry").get(record.id)?.error).toBe(
      `context limit reached but no handoff file was written at ${record.handoffPath} and the final reply is not a handoff`,
    );
  });

  it("respects a smaller model window", async () => {
    const { child } = await setup({ reserveTokens: 16_384 }, "wide");

    child.turn({ tokens: 310_000, window: 400_000, percent: 77.5 });
    await flushMicrotasks();

    expect(child.messages.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Context limit warning"),
    ]);
  });
});
