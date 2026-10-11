import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StopReason, ToolSpec } from "../../../../../core/adapter/contract.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { handoffPlugin } from "../../../src/plugins/handoff/index.ts";
import { validateHandoff } from "../../../src/plugins/handoff/schema.ts";
import { budgetStep, effectiveBudget } from "../../../src/plugins/limits/budget.ts";
import { LIMITS_SENDER, limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

const VALID_HANDOFF = [
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

const WIDE_AGENT = [
  "---",
  "name: wide",
  "description: Test agent with a budget larger than any model window.",
  "limit: 1000000",
  "subagents: []",
  "---",
  "Search wide.",
].join("\n");

const CAPPED_AGENT = [
  "---",
  "name: capped",
  "description: Test agent with a turn limit.",
  "max_turns: 2",
  "limit: 100000",
  "subagents: []",
  "---",
  "Search briefly.",
].join("\n");

const setup = async (overrides = {}, agent = "explorer") => {
  const harness = createHarness(
    [agentRegistryPlugin, agentDefinitionsPlugin, handoffPlugin, runAgentPlugin, limitsPlugin],
    { budgetTokens: 100_000, ...overrides },
  );

  const userAgentsDir = join(harness.host.info.agentDir, "agents");

  mkdirSync(userAgentsDir, { recursive: true });
  writeFileSync(join(userAgentsDir, "wide.md"), WIDE_AGENT);
  writeFileSync(join(userAgentsDir, "capped.md"), CAPPED_AGENT);
  harness.services.require("definitions").reload();

  await harness.host
    .tool<RunAgentParams, unknown>("run_agent")
    .execute({ agents: [{ agent, task: "huge repo" }] }, { update: () => {} });
  await flush();
  harness.host.settle();

  const record = harness.services.require("registry").list()[0];
  const child = harness.runtime.child(record.id);

  const turn = async (tokens: number, stopReason: StopReason = "toolUse", toolCalls?: number) => {
    child.turn({ tokens, window: 400_000, percent: (tokens / 400_000) * 100 }, stopReason, toolCalls);
    await flush();
  };

  return { ...harness, record, child, turn };
};

describe("budget arithmetic", () => {
  it("uses the configured budget unless the model window minus the reserve is smaller", () => {
    expect(effectiveBudget(100_000, { tokens: 0, window: 400_000, percent: 0 }, 16_384)).toBe(100_000);
    expect(effectiveBudget(100_000, { tokens: 0, window: 64_000, percent: 0 }, 16_384)).toBe(47_616);
  });

  it("warns once at the soft line, requests a handoff at the budget and aborts past the hard line", () => {
    const base = {
      budget: 100_000,
      softRatio: 0.8,
      hardRatio: 1.15,
      warned: false,
      handoffRequested: false,
      turnsSinceHandoff: 0,
      maxTurnsAfterHandoff: 3,
    };

    expect(budgetStep({ ...base, tokens: 79_999 })).toBe("none");
    expect(budgetStep({ ...base, tokens: 80_000 })).toBe("warn");
    expect(budgetStep({ ...base, tokens: 85_000, warned: true })).toBe("none");
    expect(budgetStep({ ...base, tokens: 100_000, warned: true })).toBe("handoff");
    expect(budgetStep({ ...base, tokens: 110_000, handoffRequested: true })).toBe("none");
    expect(budgetStep({ ...base, tokens: 115_000, handoffRequested: true })).toBe("abort");
    expect(budgetStep({ ...base, tokens: 101_000, handoffRequested: true, turnsSinceHandoff: 3 })).toBe(
      "abort",
    );
  });
});

describe("limits plugin", () => {
  it("triggers the warning and the handoff on the turns that cross the lines, through the message route", async () => {
    const { child, turn, record, services } = await setup();

    await turn(50_000);

    expect(child.messages).toEqual([]);

    await turn(81_000);

    expect(child.messages).toHaveLength(1);
    expect(child.messages[0].message.sender).toBe(LIMITS_SENDER);
    expect(child.messages[0].message.text).toContain("Context budget warning");
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

    expect(services.require("registry").get(record.id)?.state).toBe("handoff");
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toContain(`Handoff file: ${record.handoffPath}`);
  });

  it("closes the agent as handoff with the validation errors when the handoff file is invalid", async () => {
    const { child, turn, record, services, host } = await setup();

    await turn(100_500);

    mkdirSync(dirname(record.handoffPath), { recursive: true });
    writeFileSync(record.handoffPath, VALID_HANDOFF.replace("partial", "done"));
    child.finish("wrote it");

    const closed = services.require("registry").get(record.id);

    expect(closed).toMatchObject({
      state: "handoff",
      error: "Status must be one of partial, blocked",
      resultText: VALID_HANDOFF.replace("partial", "done"),
    });
    expect(closed?.successorId).toBeUndefined();
    expect(host.sent[0]).toContain(
      `Handoff file: ${record.handoffPath} (invalid: Status must be one of partial, blocked)`,
    );
  });

  it("fails the agent when the handoff file is missing", async () => {
    const { child, turn, record, services } = await setup();

    await turn(100_500);
    child.finish("wrote it");

    const closed = services.require("registry").get(record.id);

    expect(closed?.state).toBe("failed");
    expect(closed?.error).toBe(
      `context budget reached but no handoff file was written at ${record.handoffPath}`,
    );
  });

  it("aborts an agent that keeps going past the hard line", async () => {
    const { child, turn, record, services } = await setup();

    await turn(100_500);
    await turn(116_000);

    expect(child.aborted).toBe(true);
    expect(services.require("registry").get(record.id)?.error).toBe(
      `context budget reached but no handoff file was written at ${record.handoffPath}`,
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
      expect.stringContaining("Context budget warning"),
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
      expect.stringContaining("Context budget warning"),
    ]);
  });

  it("requests the handoff on the next continuing wake turn of an over-budget agent waiting on its own batch", async () => {
    const { child, turn, record, runtime, services } = await setup({}, "general");
    const registry = services.require("registry");
    const runChild = child.spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as ToolSpec<
      RunAgentParams,
      unknown
    >;

    await runChild.execute({ agents: [{ agent: "explorer", task: "look" }] }, { update: () => {} });
    await flush();
    await turn(100_500, "stop");
    child.finish("Started batch, waiting.");
    await flush();

    expect(registry.get(record.id)).toMatchObject({ state: "running", handoffRequested: false });
    expect(child.messages).toEqual([]);

    runtime.child(registry.list()[1].id).finish("found it in src/a.ts");
    await flush();

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

  it("warns at the turn limit and aborts past the grace only on turns that continue", async () => {
    const { child, turn, record, services } = await setup({}, "capped");

    await turn(1_000);
    await turn(1_000, "stop");

    expect(child.messages).toEqual([]);

    await turn(1_000);

    expect(child.messages.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Turn limit reached (2 turns)"),
    ]);

    await turn(1_000, "stop");

    expect(child.aborted).toBe(false);

    await turn(1_000);

    expect(child.aborted).toBe(true);
    expect(services.require("registry").get(record.id)?.error).toBe("turn limit of 2 exceeded");
  });

  it("respects a smaller model window", async () => {
    const { child } = await setup({ reserveTokens: 16_384 }, "wide");

    child.turn({ tokens: 310_000, window: 400_000, percent: 77.5 });
    await flush();

    expect(child.messages.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Context budget warning"),
    ]);
  });
});

describe("handoff schema", () => {
  it("accepts the documented schema", () => {
    expect(validateHandoff(VALID_HANDOFF)).toEqual({ ok: true, status: "partial" });
  });

  it("rejects missing, empty, out-of-order sections and unknown status values", () => {
    const missing = validateHandoff("## Status\npartial\n## Outcome\nx");
    const reordered = validateHandoff(
      VALID_HANDOFF.replace("## Outcome", "## Tmp")
        .replace("## Blocker", "## Outcome")
        .replace("## Tmp", "## Blocker"),
    );
    const empty = validateHandoff(VALID_HANDOFF.replace("- trace token refresh", ""));
    const badStatus = validateHandoff(VALID_HANDOFF.replace("partial", "almost"));

    expect(missing).toEqual({
      ok: false,
      errors: ["missing sections: Evidence, Blocker, Next, Files touched"],
    });
    expect(reordered.ok).toBe(false);
    expect(empty).toEqual({ ok: false, errors: ["empty sections: Next"] });
    expect(badStatus).toEqual({ ok: false, errors: ["Status must be one of partial, blocked"] });
  });

  it("rejects a done status because a finished agent never writes a handoff", () => {
    expect(validateHandoff(VALID_HANDOFF.replace("partial", "done"))).toEqual({
      ok: false,
      errors: ["Status must be one of partial, blocked"],
    });
    expect(validateHandoff(VALID_HANDOFF.replace("partial", "blocked"))).toEqual({
      ok: true,
      status: "blocked",
    });
  });

  it("fills the handoff instruction with the target path", () => {
    const harness = createHarness([handoffPlugin]);
    const text = harness.services.require("handoff").instruction("/tmp/x/handoff.md");

    expect(text).toContain("/tmp/x/handoff.md");
    expect(text).not.toContain("{{path}}");
  });
});
