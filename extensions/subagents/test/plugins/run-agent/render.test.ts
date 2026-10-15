import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike, ToolRender, ToolResult } from "../../../../../core/adapter/contract.ts";
import { flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import type { AgentRecord, AgentRegistry } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { createRegistry } from "../../../src/plugins/agent-registry/registry.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import {
  BLOCK_WIDTH,
  type RunAgentDetails,
  type RunAgentParams,
} from "../../../src/plugins/run-agent/render.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import { createPendingCalls, runAgentTool } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, tempDir } from "../../helpers/harness.ts";

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

const toolDeps = (runner: Runner, registry: AgentRegistry) => ({
  runner,
  registry,
  calls: createPendingCalls(),
  hints: { manage: () => true, list: () => true },
});

const setup = (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], overrides);
  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner") as Runner;
  const tool = runAgentTool(toolDeps(runner, registry), "run agents");

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

const resolve = (render: ToolRender | undefined, width = BLOCK_WIDTH) =>
  typeof render === "function" ? render(width) : (render ?? "");

const renderResult = (
  harness: Harness,
  result: ToolResult<RunAgentDetails>,
  params: RunAgentParams,
  state: { isPartial?: boolean; expanded?: boolean; isError?: boolean; invalidate?: () => void } = {},
  theme: ThemeLike = plainTheme,
  width = BLOCK_WIDTH,
) =>
  resolve(
    harness.tool.renderResult?.(
      result,
      {
        toolCallId: "call-1",
        expanded: false,
        isPartial: false,
        isError: result.isError ?? false,
        args: params,
        invalidate: () => {},
        ...state,
      },
      theme,
    ),
    width,
  );

const renderCall = (
  harness: Harness,
  params: Partial<RunAgentParams>,
  isPartial: boolean,
  theme: ThemeLike = plainTheme,
) =>
  harness.tool.renderCall?.(params as RunAgentParams, theme, {
    toolCallId: "call-1",
    expanded: false,
    isPartial,
    isError: false,
    args: params,
    invalidate: () => {},
  });

const lines = (text: string) => text.split("\n");

const tagged: ThemeLike = {
  ...plainTheme,
  fg: (token, text) => `<${token}>${text}</${token}>`,
  bold: (text) => `<b>${text}</b>`,
};

const ids = (harness: Harness) => harness.registry.list().map((record) => record.id);

const patch = (harness: Harness, id: string, values: Partial<AgentRecord>) =>
  harness.registry.update(id, values);

afterEach(() => {
  vi.useRealTimers();
});

describe("run_agent block", () => {
  it("renders nothing for the call, partial or final", () => {
    const harness = setup();

    expect(renderCall(harness, { agents: THREE }, true)).toBe("");
    expect(renderCall(harness, {}, true)).toBe("");
    expect(renderCall(harness, { agents: THREE }, false)).toBe("");
  });

  it("draws the launched header and the rows while partial", async () => {
    const harness = withWorker();
    const params = { agents: THREE, wait: true };
    const { updates } = await start(harness, THREE, true);

    expect(updates).toHaveLength(1);

    const text = renderResult(harness, { text: "", details: updates[0] }, params, { isPartial: true });

    expect(lines(text)).toHaveLength(7);
    expect(lines(text)[0]).toBe("3 agents launched");
    expect(lines(text)[1]).toMatch(/^├─ explorer \(Map the auth module\)/);

    const background = renderResult(
      harness,
      { text: "", details: updates[0] },
      { agents: THREE },
      { isPartial: true },
    );

    expect(lines(background)[0]).toBe("3 background agents launched (↓ to manage · ← to list)");
  });

  it("headers: launched with hint, launched without hint, finished", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);
    const params = { agents: THREE };

    expect(lines(renderResult(harness, result, params))[0]).toBe(
      "3 background agents launched (↓ to manage · ← to list)",
    );

    harness.runtime.children.forEach((child) => {
      child.finish("ok");
    });
    await flush();

    expect(lines(renderResult(harness, result, params))[0]).toBe("3 background agents launched");
    expect(lines(renderResult(harness, result, { ...params, wait: true }))[0]).toBe("3 agents finished");

    const single = await launched(harness, [item("worker", "one")]);

    expect(lines(renderResult(harness, single, { agents: [item("worker", "one")] }))[0]).toBe(
      "1 background worker agent launched (↓ to manage · ← to list)",
    );
  });

  it("shortens the hint to the panel key when the header does not fit", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);
    const header = (width: number) =>
      lines(renderResult(harness, result, { agents: THREE }, {}, plainTheme, width))[0];

    expect(header(54)).toBe("3 background agents launched (↓ to manage · ← to list)");
    expect(header(53)).toBe("3 background agents launched (↓ to manage)");
  });

  it("headers name the agent when the batch shares one", async () => {
    const harness = withWorker();
    const explorers = [item("explorer", "a"), item("explorer", "b"), item("explorer", "c")];
    const result = await launched(harness, explorers);

    expect(
      lines(renderResult(harness, result, { agents: explorers, wait: true }, { isPartial: true }))[0],
    ).toBe("3 explorer agents launched");
    expect(lines(renderResult(harness, result, { agents: explorers }))[0]).toBe(
      "3 background explorer agents launched (↓ to manage · ← to list)",
    );
    expect(lines(renderResult(harness, result, { agents: explorers, wait: true }))[0]).toBe(
      "3 explorer agents finished",
    );
    expect(lines(renderResult(harness, result, { agents: explorers }))[1]).toMatch(/^├─ explorer \(a\)/);

    const one = await launched(harness, [explorers[0]]);

    expect(lines(renderResult(harness, one, { agents: [explorers[0]] }))[0]).toBe(
      "1 background explorer agent launched (↓ to manage · ← to list)",
    );

    const mixed = [item("explorer", "a"), item("worker", "b")];
    const both = await launched(harness, mixed);

    expect(lines(renderResult(harness, both, { agents: mixed }))[0]).toBe(
      "2 background agents launched (↓ to manage · ← to list)",
    );
  });

  it("names only the keys of the enabled panel and list plugins", async () => {
    const header = async (disabledPlugins: string[], width?: number) => {
      const harness = withWorker({ disabledPlugins });
      const result = await launched(harness, THREE);

      return lines(
        harness.host.renderTool("run_agent", { call: { agents: THREE }, result, width }).result ?? "",
      )[0];
    };

    expect(await header([])).toBe("3 background agents launched (↓ to manage · ← to list)");
    expect(await header(["agent-view"])).toBe("3 background agents launched (↓ to manage)");
    expect(await header(["agent-panel"])).toBe("3 background agents launched (← to list)");
    expect(await header(["agent-panel"], 40)).toBe("3 background agents launched");
    expect(await header(["agent-panel", "agent-view"])).toBe("3 background agents launched");
  });

  it("points Status unavailable at /agents only while the list plugin is on", () => {
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["explorer-abc"],
      agents: [{ id: "explorer-abc", agent: "explorer", description: "Map the auth module" }],
    };
    const status = (disabledPlugins: string[]) =>
      lines(
        setup({ disabledPlugins }).host.renderTool("run_agent", {
          call: { agents: [THREE[0]] },
          result: { text: "Started batch", details },
        }).result ?? "",
      )[2];

    expect(status([])).toBe("   Status unavailable · /agents explorer-abc");
    expect(status(["agent-view"])).toBe("   Status unavailable");
  });

  it("draws no hint for a batch an agent started", async () => {
    const harness = withWorker();

    await launched(harness, [item("general", "Lead the fix")]);

    const [parent] = ids(harness);
    const nested = harness.runtime
      .child(parent)
      .spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as typeof harness.tool;
    const agents = [item("explorer", "Find the callers")];
    const result = await nested.execute({ agents }, { update: () => {} });

    expect(lines(renderResult(harness, result, { agents }))[0]).toBe("1 background explorer agent launched");
  });

  it("keeps a drawn block until it is rendered again", async () => {
    const harness = withWorker();
    const result = await launched(harness, [THREE[0]]);
    const [id] = ids(harness);
    const draw = harness.tool.renderResult?.(
      result,
      { ...harness.host.renderTool("run_agent", {}).state, args: { agents: [THREE[0]] } },
      plainTheme,
    );
    const at = (width: number) => (typeof draw === "function" ? draw(width) : "");
    const before = at(BLOCK_WIDTH);

    expect(before).toContain("Initializing…");

    patch(harness, id, { turns: 1, toolCalls: 2 });

    expect(at(BLOCK_WIDTH)).toBe(before);
    expect(at(80)).toContain("Running in the background");
    expect(renderResult(harness, result, { agents: [THREE[0]] })).toContain("Running in the background");
  });

  it("keeps every line within BLOCK_WIDTH and leaves the padding to the adapter", async () => {
    const harness = withWorker();
    const long = [item("explorer", "x".repeat(300)), item("worker", "y".repeat(300))];
    const result = await launched(harness, long);
    const rendered = lines(renderResult(harness, result, { agents: long }));

    rendered.forEach((line) => {
      expect(plainTheme.width(line)).toBeLessThanOrEqual(BLOCK_WIDTH);
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

    expect(plainTheme.width(failed)).toBeLessThanOrEqual(BLOCK_WIDTH);
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

    expect(plainTheme.width(row)).toBeLessThanOrEqual(BLOCK_WIDTH);
    expect(row).toMatch(/d…\) · \S+\/\S+:\w+$/);

    const rebuilt = runAgentTool(
      toolDeps(harness.runner, createRegistry({ bus: harness.bus, handoffPath: (id) => id })),
      "run agents",
    );
    const name = "n".repeat(70);
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["a-1"],
      agents: [{ id: "a-1", agent: name, description: "d".repeat(120), model: "fake/model:high" }],
    };
    const crowded = lines(
      resolve(
        rebuilt.renderResult?.(
          { text: "", details },
          { ...harness.host.renderTool("run_agent", {}).state, args: { agents: [] } },
          plainTheme,
        ),
      ),
    )[1];

    expect(crowded.endsWith("…)")).toBe(true);
    expect(crowded).not.toContain("fake/model");
    expect(plainTheme.width(crowded)).toBeLessThanOrEqual(BLOCK_WIDTH);

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
    const tool = runAgentTool(toolDeps(harness.runner, registry), "run agents");
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
    const text = resolve(
      tool.renderResult?.(
        { text: "Started batch", details },
        {
          toolCallId: "c",
          expanded: false,
          isPartial: false,
          isError: false,
          args: { agents: THREE },
          invalidate: () => {},
        },
        plainTheme,
      ),
    );

    expect(lines(text).slice(0, 3)).toEqual([
      "3 background agents launched",
      "├─ explorer (Map the auth module) · fake/model:high",
      "│  Status unavailable · /agents explorer-abc",
    ]);
  });

  it("invalidates at once, then at most once per renderThrottleMs, and stops at batch:settled", async () => {
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

    expect(invalidate).toHaveBeenCalledTimes(1);

    patch(harness, id, { turns: 2 });
    patch(harness, id, { turns: 3 });

    expect(invalidate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60);

    expect(invalidate).toHaveBeenCalledTimes(2);

    harness.runtime.children[0].finish("done");

    expect(invalidate).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60);
    patch(harness, id, { turns: 9 });
    vi.advanceTimersByTime(60);

    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("registers no invalidate for a settled batch or an unknown batch", async () => {
    const harness = withWorker({ renderThrottleMs: 50 });
    const main = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    harness.host.idle = false;

    const first = await main.execute({ agents: [THREE[0]] }, { update: () => {} });
    const second = await main.execute({ agents: [THREE[1]] }, { update: () => {} });

    await flush();

    const settled = vi.fn();
    const redrawn = vi.fn();
    const other = vi.fn();
    const unknown = vi.fn();
    const render = (result: ToolResult<unknown>, invalidate: () => void) =>
      harness.host.renderTool("run_agent", { call: { agents: [THREE[0]] }, result, state: { invalidate } });

    vi.useFakeTimers();
    render(first, settled);
    render(second, other);
    harness.runtime.children[0].finish("done");

    expect(settled).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);

    render(first, redrawn);
    render({ text: "Started batch", details: { batchId: "b-unknown", ids: [], agents: [] } }, unknown);

    const [, b] = ids(harness);

    patch(harness, b, { turns: 1 });
    vi.advanceTimersByTime(60);

    expect(other).toHaveBeenCalledTimes(2);
    expect(redrawn).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(2);
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

describe("run_agent block box tone", () => {
  const tone = (
    harness: Harness,
    result: ToolResult<RunAgentDetails>,
    params: RunAgentParams,
    state: { isPartial?: boolean; isError?: boolean } = {},
  ) => harness.host.renderTool("run_agent", { call: params, result, state }).tone;

  it("draws pi's tool box", () => {
    expect(setup().tool.renderShell).toBe("box");
  });

  it("background batch: pending after the call returned while an agent is open, success once all are done", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);
    const params = { agents: THREE };

    expect(tone(harness, result, params)).toBe("pending");

    const [first, ...rest] = harness.runtime.children;

    first?.finish("ok");
    await flush();

    expect(tone(harness, result, params)).toBe("pending");

    rest.forEach((child) => {
      child.finish("ok");
    });
    await flush();

    expect(tone(harness, result, params)).toBe("success");
  });

  it("waiting batch: pending while partial, success on the final result", async () => {
    const harness = withWorker();
    const params = { agents: THREE, wait: true };
    const { updates, pending } = await start(harness, THREE, true);

    expect(tone(harness, { text: "", details: updates[0] }, params, { isPartial: true })).toBe("pending");

    harness.runtime.children.forEach((child) => {
      child.finish("ok");
    });

    expect(tone(harness, await pending, params)).toBe("success");
  });

  it("error once every agent closed and one failed; stopped stays success", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);
    const [first, second, third] = ids(harness);
    const params = { agents: THREE };

    harness.registry.close(first, { state: "failed", error: "boom" });

    expect(tone(harness, result, params)).toBe("pending");

    harness.registry.close(second, { state: "stopped" });
    harness.registry.close(third, { state: "done" });

    expect(tone(harness, result, params)).toBe("error");

    patch(harness, first, { state: "handoff" });

    expect(tone(harness, result, params)).toBe("success");
  });

  it("error when the tool errored", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);
    const params = { agents: THREE };

    expect(tone(harness, { isError: true, text: "unknown agent(s): x" }, params)).toBe("error");
    expect(tone(harness, { ...result, isError: true }, params)).toBe("error");
  });

  it("falls back to pi's rule without registry records", () => {
    const harness = setup();
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["explorer-abc"],
      agents: [{ id: "explorer-abc", agent: "explorer", description: "Map the auth module" }],
    };
    const params = { agents: [THREE[0]] };

    expect(
      harness.tool.renderTone?.(harness.host.renderTool("run_agent", {}).state, { text: "", details }),
    ).toBe(undefined);
    expect(tone(harness, { text: "", details }, params)).toBe("success");
    expect(tone(harness, { text: "", details }, params, { isPartial: true })).toBe("pending");
  });
});

describe("run_agent block colours", () => {
  it("paints the header: count bold, hint dim", async () => {
    const harness = withWorker();
    const result = await launched(harness, THREE);

    expect(
      lines(renderResult(harness, result, { agents: THREE, wait: true }, { isPartial: true }, tagged))[0],
    ).toBe("<b>3</b> agents launched");
    expect(lines(renderResult(harness, result, { agents: THREE }, {}, tagged))[0]).toBe(
      "<b>3</b> background agents launched <dim>(↓ to manage · ← to list)</dim>",
    );
    expect(lines(renderResult(harness, result, { agents: THREE, wait: true }, {}, tagged))[0]).toBe(
      "<b>3</b> agents finished",
    );
    expect(renderResult(harness, { isError: true, text: "bad\nmore" }, { agents: THREE }, {}, tagged)).toBe(
      "<error>✗ No agents started: bad</error>",
    );
  });

  it("paints the name line: agent bold, description muted, model dim", async () => {
    const harness = withWorker();
    const result = await launched(harness, [THREE[0]]);
    const model = harness.registry.list()[0].model;

    expect(lines(renderResult(harness, result, { agents: [THREE[0]] }, {}, tagged))[1]).toBe(
      `└─ <b>explorer</b> <muted>(Map the auth module)</muted><dim> · ${model}</dim>`,
    );
  });

  it("paints every status line in its state token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const harness = withWorker({ maxConcurrent: 1 });
    const result = await launched(harness, THREE);
    const [first, second, third] = ids(harness);
    const statusOf = (index: number, wait = false) =>
      lines(renderResult(harness, result, { agents: THREE, wait }, {}, tagged))[2 + index * 2].slice(3);
    const closed = (id: string, values: Partial<AgentRecord>) => {
      patch(harness, id, { startedAt: 0, ...values });
      harness.registry.close(id, { state: "done", ...values });
      patch(harness, id, { ...values });
    };

    expect(statusOf(2)).toBe("<muted>Queued</muted>");
    expect(statusOf(0)).toBe("<muted>Initializing…</muted>");

    patch(harness, first, { toolCalls: 4, tokens: 12_345, turns: 2 });

    expect(statusOf(0)).toBe("<muted>Running in the background</muted>");
    expect(statusOf(0, true)).toBe("<muted>Running · 4 tool uses · 12.3k tokens</muted>");

    patch(harness, first, { state: "grace" });

    expect(statusOf(0)).toBe("<warning>Stopping…</warning>");

    closed(second, { state: "done", toolCalls: 4, tokens: 12_345, endedAt: 65_000 });
    expect(statusOf(1)).toBe("<success>Done</success><dim> · 4 tool uses · 12.3k tokens · 1m 5s</dim>");

    closed(second, { state: "failed", error: "tests failed twice\nstack" });
    expect(statusOf(1)).toBe("<error>Failed: tests failed twice</error>");

    closed(second, { state: "stopped", toolCalls: 0, tokens: 0, endedAt: 3_000 });
    expect(statusOf(1)).toBe("<muted>Stopped · 0 tool uses · 3s</muted>");

    closed(second, { state: "handoff", toolCalls: 4, tokens: 12_345, endedAt: 3_720_000 });
    expect(statusOf(1)).toBe("<warning>Handed off · 4 tool uses · 12.3k tokens · 1h 2m</warning>");

    closed(third, { state: "done", toolCalls: 1, tokens: 0, endedAt: 1_000 });
    patch(harness, third, {
      worktree: { path: "/w", branch: "pi-agents/x-1", base: "abc", cwd: "/w", cleanup: "removed" },
    });

    expect(statusOf(2)).toBe(
      "<success>Done</success><dim> · 1 tool use · 1s</dim><dim> · worktree removed</dim>",
    );
  });

  it("paints Status unavailable dim", () => {
    const harness = setup();
    const registry = createRegistry({ bus: harness.bus, handoffPath: (id: string) => id });
    const tool = runAgentTool(toolDeps(harness.runner, registry), "run agents");
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["explorer-abc"],
      agents: [{ id: "explorer-abc", agent: "explorer", description: "Map the auth module" }],
    };
    const text = resolve(
      tool.renderResult?.(
        { text: "Started batch", details },
        { ...harness.host.renderTool("run_agent", {}).state, args: { agents: [THREE[0]] } },
        tagged,
      ),
    );

    expect(lines(text)[2]).toBe("   <dim>Status unavailable · /agents explorer-abc</dim>");
  });
});

describe("run_agent block width", () => {
  const forty = `${"d".repeat(39)}e`;

  it("keeps the description and the whole model at width 80 and at width 120", async () => {
    const harness = withWorker();
    const agents = [item("explorer", forty)];
    const result = await launched(harness, agents);
    const model = harness.registry.list()[0].model as string;
    const at = (width: number) =>
      lines(harness.host.renderTool("run_agent", { call: { agents }, result, width }).result ?? "")[1];

    expect(at(80)).toBe(`└─ explorer (${forty}) · ${model}`);
    expect(plainTheme.width(at(80))).toBeLessThanOrEqual(78);
    expect(at(120)).toBe(`└─ explorer (${forty}) · ${model}`);
  });

  it("cuts the description, never the model, against the real width and drops the model when it does not fit", async () => {
    const harness = withWorker();
    const agents = [item("explorer", "d".repeat(60))];
    const result = await launched(harness, agents);
    const model = harness.registry.list()[0].model as string;
    const at = (width: number) =>
      lines(harness.host.renderTool("run_agent", { call: { agents }, result, width }).result ?? "")[1];

    expect(at(80).endsWith(`…) · ${model}`)).toBe(true);
    expect(plainTheme.width(at(80))).toBe(78);
    expect(at(120)).toBe(`└─ explorer (${"d".repeat(60)}) · ${model}`);
    expect(at(50)).not.toContain(model);
    expect(at(50).endsWith("…)")).toBe(true);
    expect(plainTheme.width(at(50))).toBeLessThanOrEqual(48);
    expect(plainTheme.width(at(200))).toBeLessThanOrEqual(BLOCK_WIDTH);
  });

  it("wraps an expanded long error at the real width instead of cutting it", () => {
    const harness = setup();
    const error = `unknown agent(s): ${"x".repeat(150)}`;
    const result = { isError: true, text: error };
    const rendered = lines(
      harness.host.renderTool("run_agent", {
        call: { agents: [item("x", "y")] },
        result,
        state: { expanded: true },
        width: 80,
      }).result ?? "",
    );
    const body = rendered.slice(1);

    expect(body.length).toBeGreaterThan(2);
    expect(body.every((line) => line.startsWith("   "))).toBe(true);
    expect(body.map((line) => line.slice(3)).join("")).toBe(error);
  });
});
