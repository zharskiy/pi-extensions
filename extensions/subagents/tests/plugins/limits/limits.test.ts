import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StopReason, ToolSpec } from "../../../../../pi-adapter/index.ts";
import { flushMicrotasks, hiddenMessageTexts, VALID_HANDOFF } from "../../../../../test-framework/index.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { contextStep } from "../../../src/plugins/limits/context-step.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
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

describe("context limit steps", () => {
  it("warns once at the soft line, requests a handoff at the limit and aborts past the hard line", () => {
    const base = {
      limit: 100_000,
      softRatio: 0.8,
      hardRatio: 1.15,
      warned: false,
      handoffRequested: false,
      turnsSinceHandoff: 0,
    };

    expect(contextStep({ ...base, tokens: 79_999 })).toBe("none");
    expect(contextStep({ ...base, tokens: 80_000 })).toBe("warn");
    expect(contextStep({ ...base, tokens: 85_000, warned: true })).toBe("none");
    expect(contextStep({ ...base, tokens: 100_000, warned: true })).toBe("handoff");
    expect(contextStep({ ...base, tokens: 110_000, handoffRequested: true, turnsSinceHandoff: 1 })).toBe(
      "none",
    );
    expect(contextStep({ ...base, tokens: 115_000, handoffRequested: true, turnsSinceHandoff: 2 })).toBe(
      "abort",
    );
    expect(contextStep({ ...base, tokens: 101_000, handoffRequested: true, turnsSinceHandoff: 3 })).toBe(
      "abort",
    );
  });

  it("gives the agent one turn past the hard line after the handoff request", () => {
    const base = {
      limit: 100_000,
      softRatio: 0.8,
      hardRatio: 1.15,
      warned: true,
      handoffRequested: true,
      tokens: 150_000,
    };

    expect(contextStep({ ...base, turnsSinceHandoff: 0 })).toBe("none");
    expect(contextStep({ ...base, turnsSinceHandoff: 1 })).toBe("none");
    expect(contextStep({ ...base, turnsSinceHandoff: 2 })).toBe("abort");
  });

  it("aborts three turns after the handoff request even under the hard line", () => {
    const base = {
      limit: 100_000,
      softRatio: 0.8,
      hardRatio: 1.15,
      warned: true,
      handoffRequested: true,
      tokens: 101_000,
    };

    expect(contextStep({ ...base, turnsSinceHandoff: 2 })).toBe("none");
    expect(contextStep({ ...base, turnsSinceHandoff: 3 })).toBe("abort");
  });
});

describe("limits plugin", () => {
  it("triggers the warning and the handoff on the turns that cross the lines, through the message route", async () => {
    const { child, turn, record, services } = await setup();

    await turn(50_000);

    expect(child.messages).toEqual([]);

    await turn(81_000);

    expect(child.messages).toHaveLength(1);
    expect(child.messages[0].message.sender).toBe("pi-subagents");
    expect(child.messages[0].message.text).toContain("Context limit warning");
    expect(child.messages[0].delivery).toBe("steer");

    await turn(90_000);

    expect(child.messages).toHaveLength(1);

    await turn(100_500);

    expect(child.messages).toHaveLength(2);
    expect(child.messages[1].message.text).toContain(record.handoffPath);
    expect(child.messages[1].message.text).toContain("## Files touched");
    expect(services.require("registry").get(record.id)?.handoffRequested).toBe(true);
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
