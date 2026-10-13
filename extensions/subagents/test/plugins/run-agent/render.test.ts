import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike, ToolResult } from "../../../../../core/adapter/contract.ts";
import { flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import { displayWidth } from "../../../src/components/format.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { createRegistry } from "../../../src/plugins/agent-registry/registry.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { BLOCK_WIDTH } from "../../../src/plugins/run-agent/render.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import {
  type RunAgentDetails,
  type RunAgentParams,
  runAgentTool,
} from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, tempDir } from "../../helpers/harness.ts";

const NOW = 250;

type Agent = RunAgentParams["agents"][number];

const item = (agent: string, description: string): Agent => ({ agent, task: description, description });

const THREE = [
  item("explorer", "Map the auth module"),
  item("worker", "Fix the login redirect"),
  item("reviewer", "Review the diff of PR 5"),
];

const WORKER = [
  "---",
  "name: worker",
  "description: Test worker.",
  "limit: 50000",
  "tools: all",
  "skills: all",
  "subagents: []",
  "---",
  "Work.",
].join("\n");

const setup = (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], overrides);
  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;
  const tool = runAgentTool({ runner, registry, now: () => NOW }, "run agents");

  return { ...harness, registry, runner, tool };
};

const withWorker = (overrides = {}) => {
  const harness = setup(overrides);
  const dir = `${harness.host.info.agentDir}/agents`;

  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/worker.md`, WORKER);
  harness.host.start();

  return harness;
};

type Harness = ReturnType<typeof setup>;

const start = async (harness: Harness, agents: Agent[], wait = false) => {
  const updates: (RunAgentDetails | undefined)[] = [];

  harness.host.idle = false;

  const pending = harness.tool.execute(
    { agents, wait },
    { update: (_text, details) => updates.push(details) },
  );

  await flush();

  return { updates, pending };
};

const launched = async (harness: Harness, agents: Agent[]) => {
  const { pending } = await start(harness, agents);

  return pending;
};

const renderResult = (
  harness: Harness,
  result: ToolResult<RunAgentDetails>,
  params: RunAgentParams,
  state: { isPartial?: boolean; expanded?: boolean; isError?: boolean; invalidate?: () => void } = {},
  theme: ThemeLike = plainTheme,
) =>
  harness.tool.renderResult?.(
    result,
    {
      toolCallId: "call-1",
      expanded: false,
      isPartial: false,
      executionStarted: true,
      isError: result.isError ?? false,
      args: params,
      outputPad: 1,
      invalidate: () => {},
      ...state,
    },
    theme,
  ) ?? "";

const renderCall = (harness: Harness, params: Partial<RunAgentParams>, isPartial: boolean) =>
  harness.tool.renderCall?.(params as RunAgentParams, plainTheme, {
    toolCallId: "call-1",
    expanded: false,
    isPartial,
    executionStarted: false,
    isError: false,
    args: params,
    outputPad: 1,
    invalidate: () => {},
  });

const lines = (text: string) => text.split("\n");

const ids = (harness: Harness) => harness.registry.list().map((record) => record.id);

const patch = (harness: Harness, id: string, values: Partial<AgentRecord>) =>
  harness.registry.update(id, values);

afterEach(() => {
  vi.useRealTimers();
});

describe("run_agent block", () => {
  it("shows the spinner header with the agent count while partial", () => {
    const harness = setup();

    expect(renderCall(harness, { agents: THREE }, true)).toBe("⠹ Running 3 agents…");
    expect(renderCall(harness, { agents: [THREE[0]] }, true)).toBe("⠹ Running 1 explorer agent…");
    expect(renderCall(harness, { agents: [item("explorer", "a"), item("worker", "b")].slice(1) }, true)).toBe(
      "⠹ Running 1 worker agent…",
    );
    expect(renderCall(harness, {}, true)).toBe("⠹ Running agents…");
  });

  it("renders nothing for the call once the result is final", () => {
    expect(renderCall(setup(), { agents: THREE }, false)).toBe("");
  });

  it("renders rows only while the result is partial", async () => {
    const harness = withWorker();
    const params = { agents: THREE, wait: true };
    const { updates } = await start(harness, THREE, true);

    expect(updates).toHaveLength(1);

    const text = renderResult(harness, { text: "", details: updates[0] }, params, { isPartial: true });

    expect(lines(text)).toHaveLength(6);
    expect(lines(text)[0]).toMatch(/^├─ explorer \(Map the auth module\)/);
  });

  it("headers: launched with hint, launched without hint, finished", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);
    const params = { agents: THREE };

    expect(lines(renderResult(harness, result, params))[0]).toBe(
      "3 background agents launched (← to manage)",
    );

    harness.runtime.children.forEach((child) => {
      child.finish("ok");
    });
    await flush();

    expect(lines(renderResult(harness, result, params))[0]).toBe("3 background agents launched");
    expect(lines(renderResult(harness, result, { ...params, wait: true }))[0]).toBe("3 agents finished");

    const single = await launched(harness, [item("worker", "one")]);

    expect(lines(renderResult(harness, single, { agents: [item("worker", "one")] }))[0]).toBe(
      "1 background worker agent launched (← to manage)",
    );
  });

  it("headers name the agent when the batch shares one", async () => {
    const harness = withWorker();
    const explorers = [item("explorer", "a"), item("explorer", "b"), item("explorer", "c")];
    const result = await launched(harness, explorers);

    expect(renderCall(harness, { agents: explorers }, true)).toBe("⠹ Running 3 explorer agents…");
    expect(lines(renderResult(harness, result, { agents: explorers }))[0]).toBe(
      "3 background explorer agents launched (← to manage)",
    );
    expect(lines(renderResult(harness, result, { agents: explorers, wait: true }))[0]).toBe(
      "3 explorer agents finished",
    );
    expect(lines(renderResult(harness, result, { agents: explorers }))[1]).toMatch(/^├─ explorer \(a\)/);

    const one = await launched(harness, [explorers[0]]);

    expect(lines(renderResult(harness, one, { agents: [explorers[0]] }))[0]).toBe(
      "1 background explorer agent launched (← to manage)",
    );

    const mixed = [item("explorer", "a"), item("worker", "b")];
    const both = await launched(harness, mixed);

    expect(lines(renderResult(harness, both, { agents: mixed }))[0]).toBe(
      "2 background agents launched (← to manage)",
    );
  });

  it("keeps every line within BLOCK_WIDTH and leaves the padding to the adapter", async () => {
    const harness = withWorker();
    const long = [item("explorer", "x".repeat(300)), item("worker", "y".repeat(300))];
    const result = await launched(harness, long);
    const rendered = lines(renderResult(harness, result, { agents: long }));

    rendered.forEach((line) => {
      expect(displayWidth(line)).toBeLessThanOrEqual(BLOCK_WIDTH);
    });
    expect(rendered[0].startsWith(" ")).toBe(false);
  });

  it("status lines per state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const harness = withWorker({ maxConcurrent: 1 });
    const result = await launched(harness, THREE);
    const [first, second, third] = ids(harness);
    const status = (wait = false) =>
      lines(renderResult(harness, result, { agents: THREE, wait })).filter(
        (_, index) => index % 2 === 0 && index > 0,
      );
    const statusOf = (index: number, wait = false) => status(wait)[index].slice(3);

    expect(statusOf(0)).toBe("Initializing…");
    expect(statusOf(2)).toBe("Queued");

    patch(harness, first, { toolCalls: 4, tokens: 12_345, turns: 2 });

    expect(statusOf(0)).toBe("Running in the background");
    expect(statusOf(0, true)).toBe("Running · 4 tool uses · 12.3k tokens");

    patch(harness, first, { tokens: 0 });

    expect(statusOf(0, true)).toBe("Running · 4 tool uses");

    patch(harness, first, { state: "grace" });

    expect(statusOf(0)).toBe("Stopping…");

    const closed = (id: string, values: Partial<AgentRecord>) => {
      patch(harness, id, { startedAt: 0, ...values });
      harness.registry.close(id, { state: "done", ...values });
      patch(harness, id, { ...values });
    };

    closed(second, { state: "done", toolCalls: 4, tokens: 12_345, endedAt: 65_000 });
    expect(statusOf(1)).toBe("Done · 4 tool uses · 12.3k tokens · 1m 5s");

    closed(second, { state: "failed", error: "tests failed twice\nstack" });
    expect(statusOf(1)).toBe("Failed: tests failed twice");

    closed(second, { state: "stopped", toolCalls: 0, tokens: 0, endedAt: 3_000 });
    expect(statusOf(1)).toBe("Stopped · 0 tool uses · 3s");

    closed(second, { state: "handoff", toolCalls: 4, tokens: 12_345, endedAt: 3_720_000 });
    expect(statusOf(1)).toBe("Handed off · 4 tool uses · 12.3k tokens · 1h 2m");

    closed(third, { state: "failed", error: "e".repeat(200) });

    const failed = status()[2];

    expect(displayWidth(failed)).toBeLessThanOrEqual(BLOCK_WIDTH);
    expect(failed.endsWith("…")).toBe(true);
  });

  it("appends the worktree outcome to closed rows", async () => {
    const harness = withWorker();
    const result = await launched(harness, [THREE[0]]);
    const [id] = ids(harness);
    const worktree = { path: "/w", branch: "pi-agents/x-1", base: "abc", cwd: "/w" };
    const status = () => lines(renderResult(harness, result, { agents: [THREE[0]] }))[2];

    patch(harness, id, { worktree: { ...worktree, cleanup: "removed" } });

    expect(status()).not.toContain("worktree removed");

    harness.registry.close(id, { state: "done" });

    expect(status()).toMatch(/ · worktree removed$/);

    patch(harness, id, { worktree: { ...worktree, cleanup: "branch kept" } });

    expect(status()).toMatch(/ · branch pi-agents\/x-1 kept$/);

    patch(harness, id, { worktree: { ...worktree, cleanup: "kept" } });

    expect(status()).toMatch(/ · worktree kept$/);
  });

  it("renders a chain as one row with #n and summed stats", async () => {
    const harness = withWorker();
    const result = await launched(harness, [THREE[0]]);
    const [first] = ids(harness);
    const base = harness.registry.get(first) as AgentRecord;
    const successor = harness.registry.create({
      agent: base.agent,
      description: base.description,
      callerId: base.callerId,
      depth: base.depth,
      batchId: base.batchId,
      dir: tempDir(),
      contextLimit: base.contextLimit,
      model: base.model,
      chainIndex: 2,
      predecessorId: first,
    });

    patch(harness, first, { toolCalls: 2, startedAt: 0 });
    harness.registry.close(first, { state: "handoff", successorId: successor.id });
    patch(harness, successor.id, { toolCalls: 3, startedAt: 10_000 });
    harness.registry.close(successor.id, { state: "done" });
    patch(harness, successor.id, { endedAt: 65_000 });

    const rendered = lines(renderResult(harness, result, { agents: [THREE[0]] }));

    expect(rendered[1]).toMatch(/^└─ explorer #2 \(Map the auth module\)/);
    expect(rendered[2]).toBe("   Done · 5 tool uses · 1m 5s");
  });

  it("cuts the description to the width and drops the model first", async () => {
    const harness = withWorker();
    const long = [item("explorer", "d".repeat(120))];
    const result = await launched(harness, long);
    const row = lines(renderResult(harness, result, { agents: long }))[1];

    expect(displayWidth(row)).toBeLessThanOrEqual(BLOCK_WIDTH);
    expect(row).toMatch(/d…\) · \S+\/\S+:\w+$/);

    const rebuilt = runAgentTool(
      { runner: harness.runner, registry: createRegistry({ bus: harness.bus, handoffPath: (id) => id }) },
      "run agents",
    );
    const name = "n".repeat(70);
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["a-1"],
      agents: [{ id: "a-1", agent: name, description: "d".repeat(120), model: "fake/model:high" }],
    };
    const crowded = lines(
      rebuilt.renderResult?.(
        { text: "", details },
        { ...harness.host.renderTool("run_agent", {}).state, args: { agents: [] } },
        plainTheme,
      ) ?? "",
    )[1];

    expect(crowded.endsWith("…)")).toBe(true);
    expect(crowded).not.toContain("fake/model");
    expect(displayWidth(crowded)).toBeLessThanOrEqual(BLOCK_WIDTH);

    const short = await launched(harness, [THREE[0]]);

    expect(lines(renderResult(harness, short, { agents: [THREE[0]] }))[1]).toMatch(
      /^└─ explorer \(Map the auth module\) · \S+\/\S+:\w+$/,
    );
  });

  it("renders the error header and the full error when expanded", () => {
    const harness = setup();
    const result = { isError: true, text: "unknown agent(s): x. Available: explorer\nNothing was started." };
    const params = { agents: [item("x", "y")] };

    expect(renderResult(harness, result, params)).toBe(
      "✗ No agents started: unknown agent(s): x. Available: explorer",
    );
    expect(lines(renderResult(harness, result, params, { expanded: true }))).toEqual([
      "✗ No agents started: unknown agent(s): x. Available: explorer",
      "   unknown agent(s): x. Available: explorer",
      "   Nothing was started.",
    ]);
  });

  it("falls back to Status unavailable after a rebuild without records", () => {
    const harness = setup();
    const registry = createRegistry({
      bus: harness.bus,
      handoffPath: (id: string) => `/tmp/${id}-handoff.md`,
    });
    const tool = runAgentTool({ runner: harness.runner, registry, now: () => NOW }, "run agents");
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["explorer-abc", "worker-def", "reviewer-123"],
      agents: [
        {
          id: "explorer-abc",
          agent: "explorer",
          description: "Map the auth module",
          model: "fake/model:high",
        },
        { id: "worker-def", agent: "worker", description: "Fix the login redirect" },
        { id: "reviewer-123", agent: "reviewer", description: "Review the diff of PR 5" },
      ],
    };
    const text =
      tool.renderResult?.(
        { text: "Started batch", details },
        {
          toolCallId: "c",
          expanded: false,
          isPartial: false,
          executionStarted: true,
          isError: false,
          args: { agents: THREE },
          outputPad: 1,
          invalidate: () => {},
        },
        plainTheme,
      ) ?? "";

    expect(lines(text).slice(0, 3)).toEqual([
      "3 background agents launched",
      "├─ explorer (Map the auth module) · fake/model:high",
      "│  Status unavailable · /agents explorer-abc",
    ]);
  });

  it("invalidates at most once per renderThrottleMs and stops at batch:settled", async () => {
    const harness = withWorker({ renderThrottleMs: 50 });
    const main = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    harness.host.idle = false;

    const result = await main.execute({ agents: [THREE[0]] }, { update: () => {} });

    await flush();

    const invalidate = vi.fn();

    vi.useFakeTimers();
    harness.host.renderTool("run_agent", { call: { agents: [THREE[0]] }, result, state: { invalidate } });

    const [id] = ids(harness);

    patch(harness, id, { turns: 1 });
    patch(harness, id, { turns: 2 });
    patch(harness, id, { turns: 3 });
    vi.advanceTimersByTime(60);

    expect(invalidate).toHaveBeenCalledTimes(1);

    harness.runtime.children[0].finish("done");

    expect(invalidate).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60);
    patch(harness, id, { turns: 9 });
    vi.advanceTimersByTime(60);

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("keeps invalidating other batches when one stored invalidate throws", async () => {
    const harness = withWorker({ renderThrottleMs: 50 });
    const main = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    harness.host.idle = false;

    const first = await main.execute({ agents: [THREE[0]] }, { update: () => {} });
    const second = await main.execute({ agents: [THREE[1]] }, { update: () => {} });

    await flush();

    const broken = vi.fn(() => {
      throw new Error("disposed");
    });
    const working = vi.fn();

    vi.useFakeTimers();
    harness.host.renderTool("run_agent", {
      call: { agents: [THREE[0]] },
      result: first,
      state: { invalidate: broken },
    });
    harness.host.renderTool("run_agent", {
      call: { agents: [THREE[1]] },
      result: second,
      state: { invalidate: working },
    });

    const [a, b] = ids(harness);

    patch(harness, a, { turns: 1 });
    vi.advanceTimersByTime(60);

    expect(broken).toHaveBeenCalledTimes(1);
    expect(working).toHaveBeenCalledTimes(1);

    patch(harness, b, { turns: 1 });
    vi.advanceTimersByTime(60);

    expect(broken).toHaveBeenCalledTimes(1);
    expect(working).toHaveBeenCalledTimes(2);
  });
});
