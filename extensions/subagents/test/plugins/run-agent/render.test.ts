import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike, ToolRender, ToolResult } from "../../../../../core/adapter/contract.ts";
import { flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import type { AgentRecord, AgentRegistry, AgentState } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { createRegistry } from "../../../src/plugins/agent-registry/registry.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import { createPendingCalls, runAgentTool } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, tempDir } from "../../helpers/harness.ts";
import { newAgentInput } from "../../helpers/records.ts";

type Agent = RunAgentParams["agents"][number];

const item = (agent: string, description: string): Agent => ({ agent, task: description, description });

const THREE = [
  item("scout", "Map the auth module"),
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

const NOW = 1_000_000;

const WIDE = 79;

const toolDeps = (runner: Runner, registry: AgentRegistry) => ({
  runner,
  registry,
  calls: createPendingCalls(),
  hints: { manage: () => true, list: () => true, expandKey: () => "ctrl+o" },
});

const setup = (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], { overrides });
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

const launched = async (harness: Harness, agents: Agent[]) => {
  harness.host.idle = false;

  const pending = harness.tool.execute({ agents }, { update: () => {} });

  await flush();

  return pending;
};

const resolve = (render: ToolRender | undefined, width = WIDE) =>
  typeof render === "function" ? render(width) : (render ?? "");

type RenderState = {
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
  aborted?: boolean;
  invalidate?: () => void;
};

const renderWith = (
  tool: Harness["tool"],
  result: ToolResult<RunAgentDetails>,
  params: RunAgentParams,
  state: RenderState = {},
  theme: ThemeLike = plainTheme,
  width = WIDE,
) =>
  resolve(
    tool.renderResult?.(
      result,
      {
        toolCallId: "call-1",
        expanded: false,
        isPartial: false,
        isError: result.isError ?? false,
        args: params,
        aborted: false,
        invalidate: () => {},
        ...state,
      },
      theme,
    ),
    width,
  );

const renderResult = (
  harness: Harness,
  result: ToolResult<RunAgentDetails>,
  params: RunAgentParams,
  state: RenderState = {},
  theme: ThemeLike = plainTheme,
  width = WIDE,
) => renderWith(harness.tool, result, params, state, theme, width);

const lines = (text: string) => text.split("\n");

const tagged: ThemeLike = {
  ...plainTheme,
  fg: (token, text) => `<${token}>${text}</${token}>`,
  bold: (text) => `<b>${text}</b>`,
};

const ids = (harness: Harness) => harness.registry.list().map((record) => record.id);

const patch = (harness: Harness, id: string, values: Partial<AgentRecord>) =>
  harness.registry.update(id, values);

type Spec = {
  agent: string;
  description: string;
  model?: string;
  state?: AgentState;
  start?: number;
  end?: number;
  values?: Partial<AgentRecord>;
};

const MODEL_A = "prov/model-a:low";

const MODEL_B = "prov/model-b:high";

const batch = (specs: Spec[], options: { callerId?: string } = {}) => {
  const harness = setup();
  const registry = createRegistry({ bus: harness.bus, handoffPath: (id: string) => `/tmp/${id}-handoff.md` });
  const tool = runAgentTool(toolDeps(harness.runner, registry), "run agents");
  const records = specs.map((spec) => {
    const record = registry.create(
      newAgentInput(tempDir(), {
        agent: spec.agent,
        description: spec.description,
        model: spec.model ?? MODEL_A,
        callerId: options.callerId ?? "main",
      }),
    );
    const state = spec.state ?? "running";

    registry.update(record.id, { state, startedAt: spec.start ?? 0, turns: 1, ...spec.values });

    if (state !== "queued" && state !== "running" && state !== "grace") {
      registry.close(record.id, { state });
      registry.update(record.id, { endedAt: spec.end ?? 0 });
    }

    return registry.get(record.id) as AgentRecord;
  });
  const details: RunAgentDetails = {
    batchId: "b-1",
    ids: records.map((record) => record.id),
    agents: records.map((record) => ({
      id: record.id,
      agent: record.agent,
      description: record.description,
      model: record.model,
    })),
  };
  const params = { agents: specs.map((spec) => item(spec.agent, spec.description)) };
  const draw = (width = WIDE, options: { wait?: boolean; state?: RenderState; theme?: ThemeLike } = {}) =>
    lines(
      renderWith(
        tool,
        { text: "model text", details },
        { ...params, wait: options.wait },
        options.state,
        options.theme,
        width,
      ),
    );

  return { harness, registry, records, draw };
};

const SAMPLE_RUNNING: Spec[] = [
  { agent: "scout", description: "Map the auth module", values: { toolCalls: 2 } },
  { agent: "worker", description: "Fix the login redirect", state: "queued" },
  {
    agent: "reviewer",
    description: "Review the diff of PR 5",
    model: MODEL_B,
    values: { turns: 0 },
  },
];

const SAMPLE_CLOSED: Spec[] = [
  {
    agent: "scout",
    description: "Map the auth module",
    state: "done",
    end: 65_000,
    values: { toolCalls: 4, tokens: 12_300, cost: 0.04 },
  },
  {
    agent: "worker",
    description: "Fix the login redirect",
    state: "failed",
    end: 130_000,
    values: { toolCalls: 31, tokens: 52_400, cost: 0.21, error: "tests failed twice" },
  },
  {
    agent: "reviewer",
    description: "Review the diff of PR 5",
    model: MODEL_B,
    state: "stopped",
    start: 239_000,
    end: 242_000,
    values: { worktree: { path: "/w", branch: "pi-agents/r-1", base: "abc", cwd: "/w", cleanup: "removed" } },
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("run_agent block samples", () => {
  it("draws a running background batch with static words and the hint", () => {
    expect(batch(SAMPLE_RUNNING).draw()).toEqual([
      "◌ 3 background agents (↓ to manage, ← to list)",
      "  ↳ ◌ scout  Map the auth module · model-a:low",
      "      Running",
      "    ◌ worker  Fix the login redirect · model-a:low",
      "      Queued",
      "    ◌ reviewer  Review the diff of PR 5 · model-b:high",
      "      Starting",
    ]);
  });

  it("draws a closed batch with the batch receipt and each agent's outcome", () => {
    expect(batch(SAMPLE_CLOSED).draw()).toEqual([
      "✗ 3 background agents · 4m 2s · 35 calls · 64.7k tokens · $0.25",
      "  ↳ ✓ scout  Map the auth module · model-a:low",
      "      1m 5s · 4 calls · 12.3k tokens · $0.04",
      "    ✗ worker  Fix the login redirect · model-a:low",
      "      tests failed twice · 2m 10s · 31 calls · 52.4k tokens · $0.21",
      "    ⊘ reviewer  Review the diff of PR 5 · model-b:high",
      "      Stopped · 3s · 0 calls · worktree removed",
    ]);
  });

  it("draws a waiting batch with live figures", () => {
    const { draw } = batch([
      {
        agent: "scout",
        description: "Find callers of login",
        start: NOW - 42_000,
        values: { toolCalls: 9, tokens: 6_100, cost: 0.01, activity: "grep" },
      },
      {
        agent: "scout",
        description: "Map the auth module",
        state: "done",
        end: 65_000,
        values: { chainIndex: 2, toolCalls: 4, tokens: 12_300, cost: 0.04 },
      },
    ]);

    expect(draw(WIDE, { wait: true, state: { isPartial: true } })).toEqual([
      "◌ 2 scout agents",
      "  ↳ ◌ scout  Find callers of login · model-a:low",
      "      Elapsed 42s · 9 calls · 6.1k tokens · $0.01",
      "    ✓ scout #2  Map the auth module · model-a:low",
      "      1m 5s · 4 calls · 12.3k tokens · $0.04",
    ]);
  });

  it("puts a long failure reason under the receipt, two rows and a count line, all of it when expanded", () => {
    const reason = Array.from({ length: 5 }, (_, index) => `line ${index + 1} of the failure`).join("\n");
    const { draw } = batch([
      {
        agent: "worker",
        description: "Fix the login redirect",
        state: "failed",
        end: 130_000,
        values: { toolCalls: 31, tokens: 52_400, cost: 0.21, error: reason },
      },
    ]);

    expect(draw()).toEqual([
      "✗ 1 background worker agent · 2m 10s · 31 calls · 52.4k tokens · $0.21",
      "  ↳ ✗ worker  Fix the login redirect · model-a:low",
      "      2m 10s · 31 calls · 52.4k tokens · $0.21",
      "      line 1 of the failure",
      "      line 2 of the failure",
      "      ... (3 more lines, ctrl+o to expand)",
    ]);
    expect(draw(WIDE, { state: { expanded: true } }).slice(3)).toEqual(
      reason.split("\n").map((line) => `      ${line}`),
    );
  });

  it("leads with a short reason and wraps a long one-line reason", () => {
    const long =
      "npm test failed twice after the redirect change; the session cookie is not set on the callback route";
    const { draw } = batch([
      {
        agent: "worker",
        description: "Fix the login redirect",
        state: "failed",
        end: 130_000,
        values: { toolCalls: 31, error: long },
      },
    ]);

    expect(draw().slice(2)).toEqual([
      "      2m 10s · 31 calls",
      "      npm test failed twice after the redirect change; the session cookie is",
      "      not set on the callback route",
    ]);
  });

  it("says no agents started with the reason in the title, or under it when it is long", () => {
    const harness = setup();
    const params = { agents: [item("x", "y")] };

    expect(lines(renderResult(harness, { isError: true, text: 'unknown agent "x"' }, params))).toEqual([
      '✗ No agents started · unknown agent "x"',
    ]);

    const long = { isError: true, text: "unknown agent(s): x. Available: scout\nNothing was started." };

    expect(lines(renderResult(harness, long, params))).toEqual([
      "✗ No agents started",
      "  ↳ unknown agent(s): x. Available: scout (ctrl+o to expand)",
    ]);
    expect(lines(renderResult(harness, long, params, { expanded: true }))).toEqual([
      "✗ No agents started",
      "  ↳ unknown agent(s): x. Available: scout",
      "    Nothing was started.",
    ]);
  });

  it("draws an interrupted waiting call as stopped", () => {
    const harness = setup();
    const scouts = [item("scout", "a"), item("scout", "b"), item("scout", "c")];
    const result = { isError: true, text: "Operation aborted" };

    expect(lines(renderResult(harness, result, { agents: scouts, wait: true }, { aborted: true }))).toEqual([
      "⊘ 3 scout agents · stopped",
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
      ids: ["scout-ab12", "worker-def"],
      agents: [
        { id: "scout-ab12", agent: "scout", description: "Map the auth module", model: MODEL_A },
        { id: "worker-def", agent: "worker", description: "Fix the login redirect" },
      ],
    };

    expect(lines(renderWith(tool, { text: "Started batch", details }, { agents: THREE }))).toEqual([
      "◌ 2 background agents",
      "  ↳ » scout  Map the auth module · model-a:low",
      "      Status unavailable · /agents scout-ab12",
      "    » worker  Fix the login redirect",
      "      Status unavailable · /agents worker-def",
    ]);
  });

  it("draws the 40-column samples", () => {
    expect(batch(SAMPLE_RUNNING).draw(39)).toEqual([
      "◌ 3 background agents (↓ to manage)",
      "  ↳ ◌ scout  Map the auth module",
      "      Running",
      "    ◌ worker  Fix the login redirect",
      "      Queued",
      "    ◌ reviewer  Review the diff of PR 5",
      "      Starting",
    ]);
    expect(batch(SAMPLE_CLOSED).draw(39)).toEqual([
      "✗ 3 background agents · 4m 2s",
      "  ↳ ✓ scout  Map the auth module",
      "      1m 5s · 4 calls · 12.3k tokens",
      "    ✗ worker  Fix the login redirect",
      "      tests failed twice · 2m 10s",
      "    ⊘ reviewer  Review the diff of PR 5",
      "      Stopped · 3s · 0 calls",
    ]);
  });
});

describe("run_agent block header", () => {
  const closed = (state: AgentState): Spec => ({
    agent: "scout",
    description: "a",
    state,
    end: 1_000,
    values: { toolCalls: 1 },
  });

  it("picks the glyph: open, then failed, then all stopped, else done with the stopped count", () => {
    const head = (specs: Spec[], state?: RenderState) => batch(specs).draw(WIDE, { state })[0];

    expect(head([closed("done"), { agent: "scout", description: "b" }])).toMatch(/^◌ /);
    expect(head([closed("done"), closed("failed")])).toMatch(/^✗ 2 background scout agents · 1s · 2 calls$/);
    expect(head([closed("stopped"), closed("handoff")])).toMatch(/^⊘ /);
    expect(head([closed("done"), closed("stopped")])).toBe(
      "✓ 2 background scout agents · 1 stopped · 1s · 2 calls",
    );
    expect(head([closed("done")], { isError: true })).toMatch(/^✗ /);
  });

  it("drops ← to list first, then the whole hint, as the width shrinks", () => {
    const { draw } = batch(SAMPLE_RUNNING);

    expect(draw(46)[0]).toBe("◌ 3 background agents (↓ to manage, ← to list)");
    expect(draw(45)[0]).toBe("◌ 3 background agents (↓ to manage)");
    expect(draw(34)[0]).toBe("◌ 3 background agents");
  });

  it("names only the keys of the enabled panel and list plugins", async () => {
    const header = async (disabledPlugins: string[], width?: number) => {
      const harness = withWorker({ disabledPlugins });
      const result = await launched(harness, THREE);

      return lines(
        harness.host.renderTool("run_agent", { call: { agents: THREE }, result, width }).result ?? "",
      )[0];
    };

    expect(await header([])).toBe("◌ 3 background agents (↓ to manage, ← to list)");
    expect(await header(["agent-view"])).toBe("◌ 3 background agents (↓ to manage)");
    expect(await header(["agent-panel"])).toBe("◌ 3 background agents (← to list)");
    expect(await header(["agent-panel"], 30)).toBe("◌ 3 background agents");
    expect(await header(["agent-panel", "agent-view"])).toBe("◌ 3 background agents");
  });

  it("names the agent when the batch shares one", () => {
    expect(batch([{ agent: "scout", description: "a" }]).draw()[0]).toBe(
      "◌ 1 background scout agent (↓ to manage, ← to list)",
    );
    expect(batch([{ agent: "scout", description: "a" }]).draw(WIDE, { wait: true })[0]).toBe(
      "◌ 1 scout agent",
    );
  });

  it("draws no hint for a batch an agent started", () => {
    expect(batch(SAMPLE_RUNNING, { callerId: "general-1" }).draw()[0]).toBe("◌ 3 background agents");
  });

  it("points Status unavailable at /agents only while the list plugin is on", () => {
    const details: RunAgentDetails = {
      batchId: "b-old",
      ids: ["scout-abc"],
      agents: [{ id: "scout-abc", agent: "scout", description: "Map the auth module" }],
    };
    const status = (disabledPlugins: string[]) =>
      lines(
        setup({ disabledPlugins }).host.renderTool("run_agent", {
          call: { agents: [THREE[0]] },
          result: { text: "Started batch", details },
        }).result ?? "",
      )[2];

    expect(status([])).toBe("      Status unavailable · /agents scout-abc");
    expect(status(["agent-view"])).toBe("      Status unavailable");
  });
});

describe("run_agent block rows", () => {
  it("renders nothing for the call", () => {
    const harness = setup();
    const state = harness.host.renderTool("run_agent", {}).state;

    expect(harness.tool.renderCall?.({ agents: THREE }, plainTheme, state)).toBe("");
    expect(harness.tool.renderShell).toBe("row");
  });

  it("shows Stopping without a ticking time in the background and with it while waiting", () => {
    const { draw } = batch([{ agent: "scout", description: "a", state: "grace", start: NOW - 5_000 }]);

    expect(draw()[2]).toBe("      Stopping");
    expect(draw(WIDE, { wait: true })[2]).toBe("      Stopping · Elapsed 5s");
  });

  it("appends the worktree outcome to closed rows", () => {
    const worktree = { path: "/w", branch: "pi-agents/x-1", base: "abc", cwd: "/w" };
    const status = (cleanup: "removed" | "branch kept" | "kept", state: AgentState = "done") =>
      batch([
        {
          agent: "scout",
          description: "a",
          state,
          end: 1_000,
          values: { worktree: { ...worktree, cleanup } },
        },
      ]).draw()[2];

    expect(status("removed")).toBe("      1s · worktree removed");
    expect(status("branch kept", "handoff")).toBe("      Handed off · 1s · branch pi-agents/x-1 kept");
    expect(status("kept")).toBe("      1s · worktree kept");
    expect(
      batch([
        { agent: "scout", description: "a", values: { worktree: { ...worktree, cleanup: "removed" } } },
      ]).draw()[2],
    ).toBe("      Running");
  });

  it("renders a chain as one row with #n and summed figures", async () => {
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
      model: MODEL_A,
      chainIndex: 2,
      predecessorId: first,
    });

    patch(harness, first, { toolCalls: 2, startedAt: 0, cost: 0.01 });
    harness.registry.close(first, { state: "handoff", successorId: successor.id });
    patch(harness, successor.id, { toolCalls: 3, startedAt: 10_000, cost: 0.02 });
    harness.registry.close(successor.id, { state: "done" });
    patch(harness, successor.id, { endedAt: 65_000 });

    const rendered = lines(renderResult(harness, result, { agents: [THREE[0]] }));

    expect(rendered[1]).toBe("  ↳ ✓ scout #2  Map the auth module · model-a:low");
    expect(rendered[2]).toBe("      1m 5s · 5 calls · $0.03");
  });

  it("drops the model when fewer than 20 columns would stay for the description, then cuts the description", () => {
    const { draw } = batch([{ agent: "scout", description: "d".repeat(120) }]);

    expect(draw()[1]).toBe(`  ↳ ◌ scout  ${"d".repeat(49)}... · model-a:low`);
    expect(draw(40)[1]).toBe(`  ↳ ◌ scout  ${"d".repeat(24)}...`);
  });

  it("spans the width with no fixed cap and keeps every line within it", () => {
    const long = [
      { agent: "scout", description: "x".repeat(300) },
      { agent: "worker", description: "y".repeat(300) },
    ];
    const { draw } = batch(long);

    expect(draw(200)[1].length).toBe(200);
    [1, 2, 3, 5, 8, 12, 20, 39, 79, 200].forEach((width) => {
      [...draw(width), ...batch(SAMPLE_CLOSED).draw(width)].forEach((line) => {
        expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
      });
    });
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
    const before = at(WIDE);

    expect(before).toContain("Starting");

    patch(harness, id, { turns: 1, toolCalls: 2 });

    expect(at(WIDE)).toBe(before);
    expect(at(80)).toContain("Running");
    expect(renderResult(harness, result, { agents: [THREE[0]] })).toContain("Running");
  });
});

describe("run_agent block colours", () => {
  it("paints the header, the hint, the name line and the status by role", () => {
    const running = batch([SAMPLE_RUNNING[0]]).draw(400, { theme: tagged });

    expect(running[0]).toBe(
      "<dim>◌</dim> <b><text>1</text></b> <text>background scout agent</text> <muted>(</muted><dim>↓</dim> <muted>to manage</muted><muted>, </muted><dim>←</dim> <muted>to list</muted><muted>)</muted>",
    );
    expect(running[1]).toBe(
      "  <dim>↳</dim> <dim>◌</dim> <b><text>scout</text></b>  <muted>Map the auth module</muted><dim> · model-a:low</dim>",
    );
    expect(running[2]).toBe("      <muted>Running</muted>");

    const failed = batch([SAMPLE_CLOSED[1]]).draw(400, { theme: tagged });

    expect(failed[0]).toMatch(/^<error>✗<\/error> /);
    expect(failed[2]).toBe(
      "      <error>tests failed twice</error><muted> · </muted><muted>2m 10s</muted><muted> · </muted><muted>31 calls</muted><muted> · </muted><muted>52.4k tokens</muted><muted> · </muted><muted>$0.21</muted>",
    );
  });
});

describe("run_agent block invalidation", () => {
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
    const invalidateUnknown = vi.fn();
    const render = (result: ToolResult<unknown>, invalidate: () => void) =>
      harness.host.renderTool("run_agent", { call: { agents: [THREE[0]] }, result, state: { invalidate } });

    vi.useFakeTimers();
    render(first, settled);
    render(second, other);
    harness.runtime.children[0].finish("done");

    expect(settled).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);

    render(first, redrawn);
    render(
      { text: "Started batch", details: { batchId: "b-unknown", ids: [], agents: [] } },
      invalidateUnknown,
    );

    const [, b] = ids(harness);

    patch(harness, b, { turns: 1 });
    vi.advanceTimersByTime(60);

    expect(other).toHaveBeenCalledTimes(2);
    expect(redrawn).not.toHaveBeenCalled();
    expect(invalidateUnknown).not.toHaveBeenCalled();
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
