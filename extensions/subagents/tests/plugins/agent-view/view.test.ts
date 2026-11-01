import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  SessionRecord,
  ThemeLike,
  ToolSpec,
  ViewComponent,
} from "../../../../../platform/pi-adapter/index.ts";
import { handoffSeedMessage } from "../../../../../platform/ui-kit/index.ts";
import {
  char,
  type FakeHost,
  flushMicrotasks,
  key,
  plainLines,
  plainTheme,
  tokenTaggingTheme,
  usageTotals,
  userLine,
} from "../../../../../test/framework/index.ts";
import {
  createOverlayApi,
  disposeOverlays,
  initPiKeybindings,
  initPiRenderTheme,
  openLastOverlay,
  parseSessionLines,
  promptRecordEntry,
  readSessionFile,
  registerPiMessageRenderer,
  typed,
} from "../../../../../test/framework/pi/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { agentStatusPlugin } from "../../../api/plugins/agent-status.ts";
import { agentViewPlugin } from "../../../api/plugins/agent-view.ts";
import { limitsPlugin } from "../../../api/plugins/limits.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import type { ViewData } from "../../../core/agent-view/source.ts";
import type { AgentRecord } from "../../../core/model/agent-record.ts";
import { agentsDirFor, MANIFEST_FILE, NAMESPACE } from "../../../core/model/paths.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createAgentView, headerLines } from "../../../ui/agent-view/view.ts";
import { agentRecord, newAgentInput } from "../../support/agent-records.ts";
import { grepSession } from "../../support/recorded-grep-session.ts";
import { createHarness, spawnAgents } from "../../support/subagents-harness.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "recorded-session.jsonl");

const RECORD_ENTRY = promptRecordEntry(NAMESPACE);

initPiRenderTheme();
initPiKeybindings();

const views: ViewComponent[] = [];

const track = <T extends ViewComponent>(view: T): T => {
  views.push(view);

  return view;
};

const useFakeTime = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  views.splice(0).forEach((view) => {
    view.dispose?.();
  });
  disposeOverlays();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const fixture = () => readSessionFile(FIXTURE, RECORD_ENTRY);

const setup = (
  plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentViewPlugin],
  options: Parameters<typeof createHarness>[1] = {},
) => {
  const harness = createHarness(plugins, options);
  const registry = harness.services.require("registry");

  const openView = async (args: string, rows = 200) => {
    await harness.host.runCommand("agents", args);

    return openLastOverlay(harness.host, rows);
  };

  const open = async (id: string, rows = 200) => {
    await harness.services.require("agentView").open(id);

    return openLastOverlay(harness.host, rows);
  };

  return { ...harness, registry, openView, open };
};

type Harness = ReturnType<typeof setup>;

const closedAgent = (
  harness: Harness,
  session: SessionRecord = fixture(),
  patch: Partial<AgentRecord> = {},
) => {
  const file = join(harness.root, `recorded-${harness.registry.list().length}.jsonl`);

  writeFileSync(file, "");
  harness.runtime.sessions.set(file, session);

  const record = harness.registry.create(
    newAgentInput(join(harness.root, "agents"), { description: "t", batchId: "b-x" }),
  );

  harness.registry.close(record.id, { state: "done", sessionFile: file, ...patch });

  return record;
};

const runningAgent = async (harness = setup()) => {
  const [record] = await spawnAgents(harness, 1);

  return { harness, record };
};

type ViewOptions = {
  rows?: number;
  record?: AgentRecord;
  back?: boolean;
  stop?: () => Promise<unknown> | undefined;
  copy?: (text: string) => Promise<void>;
  width?: number;
  theme?: ThemeLike;
};

const viewOf = (session: SessionRecord | undefined, options: ViewOptions = {}) => {
  const { api, state, transcripts } = createOverlayApi({ rows: options.rows ?? 200, theme: options.theme });
  const left = { count: 0 };
  let current: ViewData = {
    record: options.record ?? agentRecord({ id: "explorer-1", state: "done", endedAt: 0 }),
    chain: [],
    session,
  };
  let changed = () => {};
  let loads = 0;

  const view = track(
    createAgentView(
      {
        load: () => {
          loads += 1;
          return current;
        },
        back: options.back ?? false,
        reserveTokens: 0,
        stop: options.stop ?? (() => undefined),
        watch: (_tickMs, onChange) => {
          changed = onChange;
          return () => {};
        },
        leave: () => {
          left.count += 1;
        },
        clipboard: { copyText: options.copy ?? (async () => {}) },
      },
      api,
    ),
  );

  const update = (next: Partial<ViewData>) => {
    current = { ...current, ...next };
    changed();
  };

  const lines = (width = options.width ?? 100) => plainLines(view.render(width));

  return { view, state, transcripts, update, lines, left, loads: () => loads };
};

const fixtureWithout = (count: number): SessionRecord => {
  const session = fixture();

  return { ...session, items: session.items.slice(0, session.items.length - count) };
};

const RULE = (width: number) => "─".repeat(width);

const requestIndex = (lines: string[]) => lines.findIndex((line) => /^ Request · /.test(line));

const firstTextAfter = (lines: string[], index: number) => lines.slice(index + 1).find((line) => line !== "");

describe("agent view", () => {
  it("opens for a closed agent by reading its session file", async () => {
    const harness = setup();
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute({ agents: [{ agent: "scout", task: "list agents" }] }, {});
    await flushMicrotasks();

    const record = harness.registry.list()[0] as AgentRecord;
    const child = harness.runtime.child(record.id);

    harness.host.settle();
    child.finish("Three files.");
    await flushMicrotasks();

    harness.runtime.sessions.set(String(child.sessionFile), fixture());
    mkdirSync(record.dir, { recursive: true });
    writeFileSync(String(child.sessionFile), "");

    const { view } = await harness.openView(record.id);
    const lines = plainLines(view.render(100));

    expect(lines[0]).toBe("");
    expect(lines[1]).toBe(" ✓ scout  list agents");
    expect(lines[2]).toMatch(/^ \d+s/);
    expect(lines[3]).toBe(` ${record.model} · id ${record.id}`);
    expect(lines[4]).toBe(RULE(100));
    expect(lines[5]).toMatch(/^ Request · \d+ lines \(r to expand\)$/);
    expect(lines[6]).toBe("");
    expect(lines.slice(7).find((line) => line.trim() !== "")).toContain("Task from");
    expect(lines).toContain(" Three files: explorer.md, implementer.md, reviewer.md.");
    expect(
      lines
        .at(-2)
        ?.startsWith(" esc to close · r to show the request · ctrl+o to expand tools · c to copy request"),
    ).toBe(true);
    expect(lines.at(-3)).toBe("");
    expect(lines.at(-1)).toBe("");
  });

  it("renders the transcript with pi's message and tool components", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const lines = plainLines(view.render(100));
    const transcript = lines.slice(requestIndex(lines) + 1, -3);
    const order = [
      " Task from main (agent id explorer-cb2e):",
      " ls /repo/agents",
      " read /repo/agents/explorer.md",
      " Three files: explorer.md, implementer.md, reviewer.md.",
    ].map((entry) => transcript.indexOf(entry));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(transcript.join("\n").trimEnd()).toMatchSnapshot();
  });

  it("toggles tool detail with the tools-expand key", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const collapsed = plainLines(view.render(100));

    view.handleKey(key("toggleTools"));

    const expanded = plainLines(view.render(100));

    expect(collapsed).not.toContain(" - One finding per line.");
    expect(expanded).toContain(" - One finding per line.");

    view.handleKey(key("toggleTools"));

    expect(plainLines(view.render(100))).toEqual(collapsed);
  });

  it("ignores Enter, Space, Tab and v", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view, state } = await harness.openView(record.id);
    const before = plainLines(view.render(100));

    view.handleKey(key("enter"));
    view.handleKey(key("space"));
    view.handleKey(key("tab"));
    view.handleKey(char("v"));

    expect(plainLines(view.render(100))).toEqual(before);
    expect(state.closed).toBe(false);
  });

  it("opens at the tail and scrolls with keys and the wheel", () => {
    const record = agentRecord({ id: "explorer-1", state: "running" });
    const { view, lines } = viewOf(fixture(), { rows: 20, record });
    const top = () => Number(/ (\d+)-\d+\/\d+/.exec(lines().at(-2) ?? "")?.[1]);

    expect(view.render(100)).toHaveLength(20);
    expect(lines().at(-2)).not.toContain("end to follow");
    expect(lines().join("\n")).toContain("Three files");

    view.handleKey(key("home"));

    expect(lines()[5]).toBe(" Request · 12 lines (r to expand)");
    expect(firstTextAfter(lines(), 5)).toBe(" Task from main (agent id explorer-cb2e):");
    expect(lines().at(-2)).toMatch(/ 1-\d+\/\d+ · end to follow$/);

    view.handleWheel?.(3);

    expect(top()).toBe(4);

    view.handleKey(key("end"));

    expect(lines().at(-2)).not.toContain("end to follow");
  });

  it("follows new entries at the tail and keeps the position when scrolled up", () => {
    const record = agentRecord({ id: "explorer-1", state: "running" });
    const { view, update, state, lines } = viewOf(fixtureWithout(2), { rows: 20, record });
    const body = () => lines().slice(5, -3);

    body();
    update({ session: fixtureWithout(1) });

    expect(state.renders).toBeGreaterThan(0);
    expect(body().join("\n")).toContain("/repo/agents/explorer.md");

    view.handleKey(key("home"));

    const before = body();

    update({ session: fixture() });

    expect(body()).toEqual(before);

    view.handleKey(key("end"));

    expect(body()).toContain(" Three files: explorer.md, implementer.md, reviewer.md.");
  });

  it("keeps the transcript when the view follows a successor and appends the successor's messages", () => {
    const full = fixture();
    const head = { ...full, items: full.items.slice(0, 2) };
    const first = agentRecord({ id: "explorer-1", state: "done", endedAt: 0, sessionFile: "/first.jsonl" });
    const second = agentRecord({ id: "explorer-2", state: "running", sessionFile: "/second.jsonl" });
    const { view, update, lines, transcripts } = viewOf(head, { record: first });
    const request = () => lines().find((line) => line.startsWith(" Request"));
    const body = () =>
      (
        lines()
          .join("\n")
          .split(request() ?? "")[1] ?? ""
      )
        .split(" esc to close")[0]
        ?.trimEnd() ?? "";
    const before = body();

    view.handleKey(char("r"));

    expect(request()).toBe(" Request · 12 lines (r to collapse)");

    update({
      record: second,
      chain: [first.id, second.id],
      session: { ...full, items: [...head.items, { kind: "user", text: "Continue with the tests" }] },
    });

    expect(request()).toBe(" Request · 12 lines (r to expand)");
    expect(body().startsWith(before)).toBe(true);
    expect(body().indexOf("Continue with the tests")).toBeGreaterThan(before.length);
    expect(transcripts).toHaveLength(1);
  });

  it("redraws the chain's transcript when an earlier link's messages change", () => {
    const full = fixture();
    const first = agentRecord({ id: "explorer-1", state: "handoff", sessionFile: "/first.jsonl" });
    const second = agentRecord({ id: "explorer-2", state: "running", sessionFile: "/second.jsonl" });
    const earlier: SessionRecord["items"] = [{ kind: "user", text: "Find the login handler" }];
    const later: SessionRecord["items"] = [{ kind: "user", text: "Trace the token refresh" }];
    const { update, lines, transcripts } = viewOf({ ...full, items: later }, { record: second });
    const body = () => lines().join("\n");

    update({ chain: [first.id, second.id], linkItems: [0, 1] });
    update({ session: { ...full, items: [...earlier, ...later] }, linkItems: [1, 1] });

    expect(body().indexOf("Find the login handler")).toBeGreaterThanOrEqual(0);
    expect(body().indexOf("Trace the token refresh")).toBeGreaterThan(
      body().indexOf("Find the login handler"),
    );
    expect(body().split("Trace the token refresh")).toHaveLength(2);
    expect(transcripts).toHaveLength(2);
  });

  it("stops the agent with the x key in a Cyrillic layout", async () => {
    const { harness, record } = await runningAgent();
    const { view } = await harness.openView(record.id);

    view.handleKey(typed("ч"));
    await flushMicrotasks();

    expect(harness.registry.get(record.id)?.state).toBe("grace");
  });

  it("enters grace on the first x and closes on the second", async () => {
    const { harness, record } = await runningAgent();
    const { view } = await harness.openView(record.id);

    expect(plainLines(view.render(100))[2]).toMatch(/^ (Starting|Elapsed)/);
    expect(plainLines(view.render(100)).at(-2)).toContain("x to stop");

    view.handleKey(char("x"));
    await flushMicrotasks();

    expect(harness.registry.get(record.id)?.state).toBe("grace");
    expect(plainLines(view.render(100)).at(-2)).toContain("x to close now");

    view.handleKey(char("x"));
    await flushMicrotasks();

    expect(harness.registry.get(record.id)?.state).toBe("stopped");
    expect(harness.runtime.child(record.id).aborted).toBe(true);
  });

  it("shows the worktree and branch under the model line", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const worktree = {
      path: "/project/.pi/worktrees/explorer-1-abc",
      branch: "pi-agents/explorer-1-abc",
      base: "0123abc",
      cwd: "/project/.pi/worktrees/explorer-1-abc",
    };

    harness.registry.update(record.id, { worktree });

    const { view } = await harness.openView(record.id);
    const lines = plainLines(view.render(100));

    expect(lines[4]).toBe(
      " Worktree /project/.pi/worktrees/explorer-1-abc · branch pi-agents/explorer-1-abc",
    );
    expect(lines[5]).toBe(RULE(100));

    harness.registry.update(record.id, { worktree: { ...worktree, cleanup: "branch kept" } });

    const again = await harness.openView(record.id);

    expect(plainLines(again.view.render(100))[4]).toBe(
      " Worktree removed · branch pi-agents/explorer-1-abc kept",
    );
  });
});

describe("agent view header", () => {
  const base = (patch: Partial<AgentRecord> = {}) =>
    agentRecord({
      id: "explorer-1",
      description: "Map the auth module",
      model: "provider/model",
      startedAt: 0,
      createdAt: 0,
      ...patch,
    });

  const header = (record: AgentRecord, theme: ThemeLike = plainTheme, width = 100, chain: string[] = []) =>
    headerLines({ record, chain }, theme, width, 0, 0);

  it("renders the header per state", () => {
    const table: [Partial<AgentRecord>, string, string][] = [
      [{ state: "queued" }, " ◌ explorer  Map the auth module", " Queued"],
      [{ state: "running" }, " ⠋ explorer  Map the auth module", " Starting"],
      [
        { state: "running", turns: 1, toolCalls: 4 },
        " ⠋ explorer  Map the auth module",
        " Elapsed 0s · 4 calls",
      ],
      [{ state: "grace" }, " ◌ explorer  Map the auth module", " Stopping · Elapsed 0s"],
      [
        { state: "done", endedAt: 0, toolCalls: 1, cost: 0.04 },
        " ✓ explorer  Map the auth module",
        " 0s · 1 call · $0.04",
      ],
      [
        { state: "failed", endedAt: 0, error: "tests failed twice\nstack" },
        " ✗ explorer  Map the auth module",
        " 0s",
      ],
      [{ state: "stopped", endedAt: 0 }, " ⊘ explorer  Map the auth module", " Stopped · 0s · 0 calls"],
      [
        { state: "handoff", endedAt: 0, handoffPath: "/tmp/h.md" },
        " ⊘ explorer  Map the auth module",
        " Handed off · 0s",
      ],
    ];

    table.forEach(([patch, title, receipt]) => {
      expect(header(base(patch)).slice(0, 3)).toEqual([title, receipt, " provider/model · id explorer-1"]);
    });

    expect(header(base({ state: "failed", error: "tests failed twice\nstack" })).slice(3, 5)).toEqual([
      " tests failed twice",
      " stack",
    ]);
    expect(header(base({ state: "handoff", handoffPath: "/tmp/h.md" }))[3]).toBe(" handoff file /tmp/h.md");
    expect(header(base({ state: "handoff", handoffPath: "/tmp/h.md", error: "missing Status" }))[3]).toBe(
      " handoff file /tmp/h.md (invalid: missing Status)",
    );

    const painted = header(
      base({ state: "failed", endedAt: 0, error: "boom" }),
      tokenTaggingTheme({ bold: true }),
    );

    expect(painted.slice(0, 4)).toEqual([
      " <error>✗</> <b>explorer</b><muted>  Map the auth module</>",
      " <muted>0s</>",
      " <dim>provider/model · id explorer-1</>",
      " <error>boom</>",
    ]);
  });

  it("wraps a long error and adds the context share to the receipt", () => {
    const error =
      "npm test failed twice after the redirect change; the session cookie is not set on the callback route";
    const record = base({
      state: "failed",
      endedAt: 130_000,
      toolCalls: 31,
      tokens: 52_400,
      cost: 0.21,
      error,
      context: { tokens: 64_000, window: 100_000, percent: 64 },
    });

    expect(header(record, plainTheme, 80).slice(1, 5)).toEqual([
      " 2m 10s · 31 calls · 52.4k tokens · $0.21 · 64% context",
      " provider/model · id explorer-1",
      " npm test failed twice after the redirect change; the session cookie is not set",
      " on the callback route",
    ]);
  });

  it("shows every line of a multi-line error up to six rows, then counts the rest", () => {
    const error = Array.from({ length: 9 }, (_, index) => `frame ${index + 1}`).join("\n");
    const lines = header(base({ state: "failed", endedAt: 0, error }), plainTheme, 80);

    expect(lines.slice(3, 10)).toEqual([
      " frame 1",
      " frame 2",
      " frame 3",
      " frame 4",
      " frame 5",
      " frame 6",
      " ... (3 more lines)",
    ]);
  });

  it("counts hidden error lines, not wrapped rows", () => {
    const error = `${"word ".repeat(40).trim()}\n${Array.from({ length: 8 }, (_, index) => `frame ${index + 1}`).join("\n")}`;
    const lines = header(base({ state: "failed", endedAt: 0, error }), plainTheme, 20);

    expect(lines.filter((line) => line.includes("more line"))).toEqual([" ... (8 more lines)"]);
  });

  it("keeps the glyph colour and the bold name when line 1 is cut below 8 columns of description", () => {
    const record = base({ state: "done", endedAt: 0 });

    expect(header(record, tokenTaggingTheme({ bold: true }), 16)[0]).toBe(
      " <success>✓</> <b>explorer</b><muted> ...</>",
    );
    expect(header(record, tokenTaggingTheme({ bold: true }), 8)[0]).toBe(" <success>✓</> <b>e...</b>");
  });

  it("names the agent and the description on line 1 and the id only on the model line", () => {
    expect(header(base({ model: undefined }))[2]).toBe(" model n/a · id explorer-1");
    expect(header(base({ chainIndex: 2 }))[0]).toBe(" ⠋ explorer #2  Map the auth module");

    const lines = header(base());

    expect(lines[0]).not.toContain("explorer-1");
    expect(lines[2]).toContain("explorer-1");
  });

  it("cuts every header line at the inner width", () => {
    const description = "d".repeat(90);
    const lines = header(
      base({
        description,
        state: "failed",
        endedAt: 0,
        error: "e".repeat(90),
        worktree: { path: `/${"p".repeat(60)}`, branch: "b", base: "x", cwd: "/" },
      }),
      plainTheme,
      40,
      ["explorer-0001-long-id", "explorer-0002-long-id"],
    );

    lines.slice(0, -1).forEach((line) => {
      expect(line.startsWith(" ")).toBe(true);
      expect(plainTheme.width(line)).toBeLessThanOrEqual(39);
    });
    expect(lines[0]).toMatch(/ {2}d{6,}\.\.\.$/);
    expect(lines.at(-1)).toBe(RULE(40));
  });

  it("omits zero tokens and an unknown context share", () => {
    const record = base({
      toolCalls: 4,
      tokens: 0,
      state: "done",
      startedAt: 0,
      endedAt: 65_000,
      contextLimit: 0,
    });

    expect(header(record)[1]).toBe(" 1m 5s · 4 calls");
    expect(header({ ...record, tokens: 12_300 })[1]).toBe(" 1m 5s · 4 calls · 12.3k tokens");
  });

  it("shows the chain index and chain links by name", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const record = base({ chainIndex: 2, predecessorId: "explorer-0001", model: undefined });
    const { lines } = viewOf(fixture(), { record });

    expect(lines()[1]).toBe(" ⠋ explorer #2  Map the auth module");
    expect(lines()[3]).toBe(" model n/a · id explorer-1");

    const chained = headerLines({ record, chain: ["explorer-0001", record.id] }, plainTheme, 100, 0, 0);

    expect(chained).toContain(" Chain explorer → explorer #2 (2 sessions) · viewing explorer #2");
  });
});

describe("agent view copy", () => {
  it("toggles the request with the r key in a Cyrillic layout", () => {
    const record = agentRecord({ id: "explorer-1", state: "done", endedAt: 0 });
    const { view, lines } = viewOf(fixture(), { rows: 40, record });

    view.handleKey(typed("к"));

    expect(lines()[5]).toBe(" Request · 12 lines (r to collapse)");

    view.handleKey(typed("к"));

    expect(lines()[5]).toBe(" Request · 12 lines (r to expand)");
  });

  it("copies the request with the c key in a Cyrillic layout", async () => {
    const harness = setup();
    const record = closedAgent(harness, requestSession());
    const { view } = await harness.openView(record.id);

    view.handleKey(typed("с"));
    await flushMicrotasks();

    expect(harness.host.copied).toEqual([JSON.stringify(PAYLOAD, null, 2)]);
  });

  it("hands the pretty-printed request to the host clipboard", async () => {
    const harness = setup();
    const record = closedAgent(harness, requestSession());
    const { view } = await harness.openView(record.id);

    view.handleKey(char("c"));
    await flushMicrotasks();

    expect(harness.host.copied).toEqual([JSON.stringify(PAYLOAD, null, 2)]);
  });
});

describe("agent view hint", () => {
  const hintOf = (record: AgentRecord, options: { back?: boolean; session?: SessionRecord } = {}) =>
    viewOf("session" in options ? options.session : fixture(), {
      record,
      back: options.back,
      rows: 400,
      width: 120,
    });

  it("writes the hint per state and per way back", () => {
    const open = agentRecord({ id: "explorer-1" });
    const grace = agentRecord({ id: "explorer-1", state: "grace" });
    const closed = agentRecord({ id: "explorer-1", state: "done", endedAt: 0 });
    const noRequest = { ...fixture(), providerPayload: undefined };
    const hint = (view: ReturnType<typeof hintOf>) => (view.lines().at(-2) ?? "").replace(/ {2,}\S+$/, "");

    expect(hint(hintOf(open))).toBe(
      " esc to close · x to stop · r to show the request · ctrl+o to expand tools · c to copy request",
    );
    expect(hint(hintOf(closed, { back: true }))).toBe(
      " esc to go back · r to show the request · ctrl+o to expand tools · c to copy request",
    );
    expect(hint(hintOf(open, { session: noRequest }))).toBe(
      " esc to close · x to stop · ctrl+o to expand tools",
    );

    const expanded = hintOf(grace, { back: true });

    expanded.view.handleKey(char("r"));

    expect(hint(expanded)).toBe(
      " esc to go back · x to close now · r to hide the request · ctrl+o to expand tools · c to copy request",
    );

    [open, grace, closed].forEach((record) => {
      expect(hintOf(record).lines().at(-2)).not.toContain("↑/↓");
    });

    const wide = hintOf(closed).view.render(100).at(-2) ?? "";

    expect(plainLines([wide])[0]).toMatch(/ 1-\d+\/\d+$/);
    expect(plainTheme.width(wide)).toBe(99);
  });

  it("drops the position when it does not fit", () => {
    const narrow = viewOf(fixture(), { record: agentRecord({ id: "explorer-1" }), width: 40 });
    const hintLine = narrow.lines().at(-2) ?? "";

    expect(hintLine).toBe(" esc to close · x to stop · r to sho...");
    expect(plainTheme.width(hintLine)).toBe(39);

    const items = Array.from({ length: 900 }, (_, index) => ({
      kind: "user" as const,
      text: `line ${index}`,
    }));
    const long = viewOf(
      { ...fixture(), items },
      { record: agentRecord({ id: "explorer-1", state: "grace" }), back: true, rows: 20, width: 80 },
    );

    long.view.handleKey(char("r"));
    long.view.handleKey(key("home"));

    expect(long.lines().at(-2)).toBe(" esc to go back · x to close now · r to hide the request");
  });

  it("pads every line and keeps the last column blank", () => {
    [80, 40].forEach((width) => {
      [
        agentRecord({ id: "explorer-1" }),
        agentRecord({ id: "explorer-1", state: "done", endedAt: 0 }),
      ].forEach((record) => {
        [false, true].forEach((expand) => {
          const { view } = viewOf(fixture(), { record, rows: 30 });

          if (expand) {
            view.handleKey(char("r"));
          }

          const lines = plainLines(view.render(width));
          const rule = lines.indexOf(RULE(width));

          expect(lines[0]).toBe("");
          expect(lines.at(-3)).toBe("");
          expect(lines.at(-1)).toBe("");
          expect(rule).toBeGreaterThan(0);
          lines.forEach((line, index) => {
            if (index === rule || line === "") {
              return;
            }

            expect(line.startsWith(" ")).toBe(true);
            expect(plainTheme.width(line)).toBeLessThanOrEqual(width - 1);
          });
        });
      });
    });
  });
});

describe("agent view body", () => {
  it("draws no Request line on a load error", async () => {
    const { harness, record } = await runningAgent();
    await harness.services.require("agentView").open(record.id);

    const { view } = openLastOverlay(harness.host, 30, tokenTaggingTheme({ bold: true }));
    const lines = view.render(100);
    const text = plainLines(lines);

    expect(lines[5]).toBe(" <warning>session file not written yet</>");
    expect(text.join("\n")).not.toContain("Request");
    expect(text.at(-2)).not.toMatch(/ r (request|hide request)/);
  });

  it("stops following on ↑, PgUp, Home and wheel-up and resumes on End", () => {
    const record = agentRecord({ id: "explorer-1" });
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ kind: "user" as const, text: `entry ${index}` }));
    const stops: ((view: ViewComponent) => void)[] = [
      (view) => view.handleKey(key("up")),
      (view) => view.handleKey(key("pageUp")),
      (view) => view.handleKey(key("home")),
      (view) => view.handleWheel?.(-1),
    ];

    stops.forEach((stop) => {
      const { view, update, lines } = viewOf({ ...fixture(), items: items(10) }, { rows: 20, record });

      lines();
      stop(view);
      update({ session: { ...fixture(), items: items(11) } });

      expect(lines().join("\n")).not.toContain("entry 10");
      expect(lines().at(-2)).toContain(" · end to follow");

      view.handleKey(key("end"));

      expect(lines().join("\n")).toContain("entry 10");
      expect(lines().at(-2)).not.toContain("end to follow");

      update({ session: { ...fixture(), items: items(12) } });

      expect(lines().join("\n")).toContain("entry 11");
    });
  });

  it("does not parse the session file again while its size and time are unchanged", async () => {
    useFakeTime();

    const harness = setup();
    const record = closedAgent(harness);
    const readSession = vi.spyOn(harness.runtime, "readSession");
    const { view } = await harness.openView(record.id);

    view.render(100);
    harness.registry.update(record.id, { tokens: 1 });
    vi.advanceTimersByTime(350);
    harness.registry.update(record.id, { tokens: 2 });
    vi.advanceTimersByTime(350);
    view.render(100);

    expect(readSession).toHaveBeenCalledTimes(1);

    writeFileSync(String(record.sessionFile), "{}\n");
    harness.registry.update(record.id, { tokens: 3 });
    vi.advanceTimersByTime(350);

    expect(readSession).toHaveBeenCalledTimes(2);
  });

  it("never reloads after close, and reports a failed stop", async () => {
    let finishStop: () => void = () => {};

    const stops = [
      () => Promise.reject(new Error("runner gone")),
      () =>
        new Promise<void>((done) => {
          finishStop = done;
        }),
    ];

    const { view, lines, loads } = viewOf(fixture(), {
      rows: 60,
      record: agentRecord({ id: "explorer-1" }),
      stop: () => stops.shift()?.(),
    });

    const quiet = lines();

    view.handleKey(char("x"));
    await flushMicrotasks();

    expect(lines().at(-3)).toBe(" Stop failed: runner gone");
    expect(lines().at(-4)).toBe("");
    expect(lines()).toHaveLength(quiet.length);
    expect(lines().slice(0, -3)).toEqual(quiet.slice(0, -3));

    view.handleKey(char("x"));
    view.dispose?.();
    finishStop();
    await flushMicrotasks();

    expect(loads()).toBe(1);
  });
});

describe("agent view with live agents", () => {
  const handoffText = [
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

  it("follows the opened link to its live successor and stops the successor", async () => {
    useFakeTime();

    const harness = createHarness(
      [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin, agentViewPlugin],
      { overrides: { stopGraceSeconds: 0 } },
    );
    const registry = harness.services.require("registry");
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute({ agents: [{ agent: "scout", task: "map the auth flow" }] }, {});
    await flushMicrotasks();
    harness.host.settle();

    const first = registry.list()[0] as AgentRecord;

    await harness.host.runCommand("agents", first.id);

    const { view } = openLastOverlay(harness.host);

    harness.runtime
      .child(first.id)
      .turn({ tokens: first.contextLimit + 500, window: 1_000_000, percent: 20 });
    await flushMicrotasks();

    mkdirSync(join(first.handoffPath, ".."), { recursive: true });
    writeFileSync(first.handoffPath, handoffText);
    harness.runtime.child(first.id).finish(first.handoffPath);
    await flushMicrotasks();
    vi.advanceTimersByTime(350);

    const second = registry.get(first.id)?.successorId as string;
    const lines = plainLines(view.render(200));

    expect(second).toBeDefined();
    expect(lines[1]).toMatch(/^ \S scout #2 {2}/);
    expect(lines[3]?.endsWith(`id ${second}`)).toBe(true);
    expect(lines).toContain(" Chain scout → scout #2 (2 sessions) · viewing scout #2");
    expect(lines.at(-2)).toContain("x to stop");
    expect(lines.join("\n")).not.toContain("(type a message)");

    view.handleKey(char("x"));
    await flushMicrotasks();

    expect(registry.get(second)?.state).toBe("stopped");
  });

  it("redraws on every 100 ms tick and re-reads the session at most once a second", async () => {
    useFakeTime();

    const { harness, record } = await runningAgent();
    const file = String(harness.registry.get(record.id)?.sessionFile);

    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
    harness.runtime.sessions.set(file, fixture());

    const readSession = vi.spyOn(harness.runtime, "readSession");
    const { view, state } = await harness.openView(record.id);

    view.render(100);

    const reads = readSession.mock.calls.length;
    const renders = state.renders;

    Array.from({ length: 10 }).forEach(() => {
      appendFileSync(file, "{}\n");
      vi.advanceTimersByTime(100);
    });

    expect(readSession.mock.calls.length - reads).toBeLessThanOrEqual(2);
    expect(readSession.mock.calls.length - reads).toBeGreaterThanOrEqual(1);
    expect(state.renders - renders).toBeGreaterThanOrEqual(9);
  });

  it("refreshes the header stats with the live turn context", async () => {
    useFakeTime();

    const { harness, record } = await runningAgent();
    const { view } = await harness.openView(record.id);

    harness.runtime.child(record.id).turn({ tokens: 85_000, window: 200_000, percent: 42 });
    await flushMicrotasks();
    vi.advanceTimersByTime(350);

    expect(plainLines(view.render(100))[2]).toMatch(/ · 85% context$/);
  });
});

describe("agent view past sessions", () => {
  type Past = {
    manifests: Record<string, unknown>[];
    cost?: number;
    sessions?: Record<string, SessionRecord>;
  };

  const writeManifest = (host: FakeHost, manifest: Record<string, unknown>) => {
    const dir = join(agentsDirFor(host.info), String(manifest.id));

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  };

  const restarted = ({ manifests, cost, sessions = {} }: Past) =>
    setup([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin], {
      beforeStart: ({ root, host, runtime }) => {
        manifests.forEach((manifest) => {
          const name = manifest.sessionFile as string | undefined;
          const file = name && join(root, name);

          if (file) {
            writeFileSync(file, "");
            runtime.sessions.set(file, sessions[name] ?? fixture());
          }

          if (file && cost !== undefined) {
            host.files.set(file, { entries: [], usage: usageTotals(cost) });
          }

          writeManifest(host, file ? { ...manifest, sessionFile: file } : manifest);
        });
      },
    });

  const openFromManifest = async (manifest: Record<string, unknown>, cost?: number) => {
    const harness = restarted({
      manifests: [{ description: "old", state: "done", sessionFile: "old.jsonl", ...manifest }],
      cost,
    });
    const { view } = await harness.openView(String(manifest.id));

    return plainLines(view.render(100));
  };

  it("shows the context limit stored in the manifest, and no context without one", async () => {
    const stored = await openFromManifest({ id: "explorer-old", agent: "scout", contextLimit: 70_000 });
    const unknown = await openFromManifest({ id: "explorer-dead", agent: "scout" });

    expect(stored[2]).toMatch(/ · 3% context$/);
    expect(unknown[2]).not.toContain("context");
  });

  it("shows persisted counters for agents of an earlier session", async () => {
    const lines = await openFromManifest({
      id: "explorer-past",
      agent: "scout",
      toolCalls: 4,
      tokens: 12_300,
      turns: 3,
      startedAt: 0,
      endedAt: 65_000,
    });

    expect(lines[2]).toBe(" 1m 5s · 4 calls · 12.3k tokens");
  });

  it("reads the cost of an agent known only from its manifest from its session file", async () => {
    const manifest = { id: "explorer-paid", agent: "scout", toolCalls: 4, startedAt: 0, endedAt: 65_000 };
    const lines = await openFromManifest(manifest, 0.04);

    expect(lines[2]).toBe(" 1m 5s · 4 calls · $0.04");
  });

  it("prefers the cost stored in the manifest", async () => {
    const manifest = {
      id: "explorer-kept",
      agent: "scout",
      toolCalls: 4,
      cost: 0.5,
      startedAt: 0,
      endedAt: 65_000,
    };
    const lines = await openFromManifest(manifest, 0.04);

    expect(lines[2]).toBe(" 1m 5s · 4 calls · $0.50");
  });

  it("shows only the time for a manifest written before counters were stored", async () => {
    const lines = await openFromManifest({
      id: "explorer-older",
      agent: "scout",
      startedAt: 0,
      endedAt: 3_000,
    });

    expect(lines[2]).toBe(" 3s");
  });

  const replyLine = (text: string) =>
    line({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

  const firstTask =
    "Task from main (agent id explorer-old1):\nAgent folder: /agents/explorer-old1\nFind the login handler";

  const seedLine = JSON.stringify({
    type: "custom_message",
    customType: "pi-handoff-seed",
    content: [
      "You continue the work of agent explorer-old1 as link 2 of its chain. Carry on from its Next section.",
      "",
      "## Next",
      "- Pick up the token refresh trace.",
      "",
      "Task from main (agent id explorer-old2):",
      "Agent folder: /agents/explorer-old2",
      "Original task:",
      "Find the login handler",
    ].join("\n"),
    display: true,
    details: { from: "agent", id: "explorer-old1", link: 2 },
  });

  const chained = (secondFile: string | undefined, sessions: Past["sessions"]) =>
    restarted({
      manifests: [
        {
          id: "explorer-old1",
          agent: "scout",
          description: "old",
          state: "handoff",
          successorId: "explorer-old2",
          sessionFile: "old-1.jsonl",
        },
        {
          id: "explorer-old2",
          agent: "scout",
          description: "old",
          state: "done",
          chainIndex: 2,
          predecessorId: "explorer-old1",
          sessionFile: secondFile,
        },
      ],
      sessions,
    });

  const seam = (lines: string[]) =>
    plainLines(lines).findIndex((line) => line.includes("── handed off · context limit ─"));

  it("shows every link of a chain in order with the seam rule, the successor's seed after it and the task once", async () => {
    const release = registerPiMessageRenderer(
      "pi-handoff-seed",
      handoffSeedMessage(() => "ctrl+o"),
    );

    onTestFinished(release);

    const session = (lines: string[]) => parseSessionLines(lines, RECORD_ENTRY);
    const harness = chained("old-2.jsonl", {
      "old-1.jsonl": session([userLine(firstTask), replyLine("The handler is in src/auth.ts.")]),
      "old-2.jsonl": session([seedLine, replyLine("Refresh lives in src/token.ts.")]),
    });

    const drawn = async (id: string) => plainLines((await harness.openView(id)).view.render(200)).join("\n");
    const text = await drawn("explorer-old1");
    const order = [
      "Find the login handler",
      "The handler is in src/auth.ts.",
      "── handed off · context limit ─",
      "handoff from agent explorer-old1 · link 2",
      "You continue the work of agent explorer-old1 as link 2 of its chain.",
      "Refresh lives in src/token.ts.",
    ].map((part) => text.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text.split("Find the login handler")).toHaveLength(2);
    expect(text).not.toContain("Original task:");
    expect(await drawn("explorer-old2")).toBe(text);

    const { view } = await harness.openView("explorer-old2");
    const rows = view.render(200);
    const rule = seam(rows);
    const blank = (row: string | undefined) => row === "";

    expect(rule).toBeGreaterThan(0);
    expect(plainLines(rows)[rule]?.endsWith("─")).toBe(true);
    expect([rows[rule - 2], rows[rule - 1], rows[rule + 1], rows[rule + 2]].map(blank)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(plainLines(rows)[rule + 2]).toContain("handoff from agent explorer-old1 · link 2");
    expect(rows.filter((row) => row.includes("handed off · context limit"))).toHaveLength(1);

    view.handleKey(key("toggleTools"));

    const expanded = plainLines(view.render(200)).join("\n");

    expect(expanded).toMatch(/Original task:\n\s+Find the login handler/);
    expect(expanded.indexOf("- Pick up the token refresh trace.")).toBeLessThan(
      expanded.indexOf("Original task:"),
    );
  });

  it("draws no seam rule while the last link has no session file", async () => {
    const harness = chained(undefined, {
      "old-1.jsonl": parseSessionLines([userLine("Find the login handler")], RECORD_ENTRY),
    });

    const rows = (await harness.openView("explorer-old2")).view.render(200);

    expect(plainLines(rows).join("\n")).toContain("Find the login handler");
    expect(seam(rows)).toBe(-1);
  });

  it("keeps the chain's transcript pane while the last link grows", async () => {
    useFakeTime();

    const session = (lines: string[]) => parseSessionLines(lines, RECORD_ENTRY);
    const harness = chained("old-2.jsonl", {
      "old-1.jsonl": session([userLine("Find the login handler")]),
      "old-2.jsonl": session([seedLine, userLine("Trace the token refresh")]),
    });
    const { view, transcripts } = await harness.openView("explorer-old2");
    const file = join(harness.root, "old-2.jsonl");
    const changed = () => {
      harness.bus.emit("agent:changed", harness.registry.get("explorer-old2") as AgentRecord);
      vi.advanceTimersByTime(1_000);
    };

    view.render(200);
    changed();
    changed();
    appendFileSync(file, "{}\n");
    harness.runtime.sessions.set(
      file,
      session([seedLine, userLine("Trace the token refresh"), userLine("Check the refresh tests")]),
    );
    changed();

    const rows = view.render(200);

    expect(plainLines(rows).join("\n")).toContain("Check the refresh tests");
    expect(rows.filter((row) => row.includes("handed off · context limit"))).toHaveLength(1);
    expect(transcripts).toHaveLength(1);
  });

  it("shows the last link's read error under the earlier links' transcript", async () => {
    const harness = restarted({
      manifests: [
        {
          id: "explorer-old1",
          agent: "scout",
          description: "old",
          state: "handoff",
          successorId: "explorer-old2",
          sessionFile: "old-1.jsonl",
        },
        {
          id: "explorer-old2",
          agent: "scout",
          description: "old",
          state: "done",
          chainIndex: 2,
          predecessorId: "explorer-old1",
        },
      ],
      sessions: { "old-1.jsonl": parseSessionLines([userLine("Find the login handler")], RECORD_ENTRY) },
    });

    await harness.services.require("agentView").open("explorer-old2");

    const { view } = openLastOverlay(harness.host, 200, tokenTaggingTheme({ bold: true }));
    const lines = view.render(200);
    const text = plainLines(lines).join("\n");

    expect(text.indexOf("Find the login handler")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("session file not written yet")).toBeGreaterThan(
      text.indexOf("Find the login handler"),
    );
    expect(lines).toContain(" <dim>session file not written yet</>");
  });

  it("shows a middle link's read error under the transcript of the links it can read", async () => {
    const harness = restarted({
      manifests: [
        {
          id: "explorer-old1",
          agent: "scout",
          description: "old",
          state: "handoff",
          successorId: "explorer-old2",
          sessionFile: "old-1.jsonl",
        },
        {
          id: "explorer-old2",
          agent: "scout",
          description: "old",
          state: "handoff",
          chainIndex: 2,
          predecessorId: "explorer-old1",
          successorId: "explorer-old3",
          sessionFile: "old-2.jsonl",
        },
        {
          id: "explorer-old3",
          agent: "scout",
          description: "old",
          state: "done",
          chainIndex: 3,
          predecessorId: "explorer-old2",
          sessionFile: "old-3.jsonl",
        },
      ],
      sessions: {
        "old-1.jsonl": parseSessionLines([userLine("Find the login handler")], RECORD_ENTRY),
        "old-3.jsonl": parseSessionLines([userLine("Trace the token refresh")], RECORD_ENTRY),
      },
    });

    harness.runtime.sessions.delete(join(harness.root, "old-2.jsonl"));

    await harness.services.require("agentView").open("explorer-old3");

    const { view } = openLastOverlay(harness.host, 200, tokenTaggingTheme({ bold: true }));
    const lines = view.render(200);
    const text = plainLines(lines).join("\n");
    const error = `cannot read session: no session ${join(harness.root, "old-2.jsonl")}`;

    expect(text.indexOf("Find the login handler")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Trace the token refresh")).toBeGreaterThan(text.indexOf("Find the login handler"));
    expect(text.indexOf(error)).toBeGreaterThan(text.indexOf("Trace the token refresh"));
    expect(lines.some((line) => line.startsWith(" <warning>cannot read session"))).toBe(true);
  });

  it("follows a chain of an earlier session to its last link", async () => {
    const harness = restarted({
      manifests: [
        {
          id: "explorer-old1",
          agent: "scout",
          description: "old",
          state: "handoff",
          successorId: "explorer-old2",
        },
        {
          id: "explorer-old2",
          agent: "scout",
          description: "old",
          state: "done",
          chainIndex: 2,
          predecessorId: "explorer-old1",
          sessionFile: "old-2.jsonl",
        },
      ],
    });

    const { view } = await harness.openView("explorer-old1");
    const lines = plainLines(view.render(200));

    expect(lines[1]).toContain("scout #2  ");
    expect(lines[3]?.endsWith("id explorer-old2")).toBe(true);
    expect(lines).toContain(" Chain scout → scout #2 (2 sessions) · viewing scout #2");
  });
});

const CODE = [
  'const hits = await tools.grep({ pattern: "login", path: "src" });',
  "const file = await tools.read({ path: hits[0].path });",
  "return file.slice(0, 200);",
].join("\n");

const OUTPUT = [
  "export const login = async (req: Request) => {",
  "  const session = await sessions.open(req);",
  "  if (!session) return redirect();",
  "  await audit(session);",
  "  return session;",
  "};",
  "export const logout = () => {};",
  "export default login;",
].join("\n");

const line = (message: Record<string, unknown>) => JSON.stringify({ type: "message", message });

const codemodeSession = () =>
  parseSessionLines(
    [
      line({
        role: "user",
        content: [{ type: "text", text: "Task from main (agent id explorer-1): Map it" }],
      }),
      line({
        role: "assistant",
        content: [
          { type: "text", text: "I will start with the login path." },
          { type: "toolCall", id: "cm1", name: "codemode", arguments: { code: CODE } },
        ],
        stopReason: "toolUse",
      }),
      line({
        role: "toolResult",
        toolCallId: "cm1",
        toolName: "codemode",
        content: [
          { type: "text", text: "Script completed\nWall time 0.42 seconds\nOutput:\n" },
          { type: "text", text: OUTPUT },
        ],
        details: {
          calls: [
            {
              id: "n1",
              name: "grep",
              args: '{"pattern":"login","path":"src"}',
              status: "ok",
              durationMs: 120,
            },
            { id: "n2", name: "read", args: '{"path":"src/auth/login.ts"}', status: "ok", durationMs: 40 },
          ],
        },
        isError: false,
        durationMs: 420,
      }),
      line({
        role: "assistant",
        content: [
          { type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "session", path: "src/auth" } },
        ],
        stopReason: "toolUse",
      }),
    ],
    RECORD_ENTRY,
  );

describe("agent view codemode", () => {
  it("renders codemode calls with pi's renderer", () => {
    const { lines } = viewOf(codemodeSession(), {
      record: agentRecord({ id: "explorer-1" }),
      rows: 400,
      width: 120,
    });
    const all = lines();
    const text = all.join("\n");

    expect(all).toContain(" codemode");
    expect(all).toContain(' const hits = await tools.grep({ pattern: "login", path: "src" });');
    expect(all.some((entry) => entry.startsWith(' ✓ grep {"pattern":"login","path":"src"}'))).toBe(true);
    expect(all.some((entry) => entry.startsWith(' ✓ read {"path":"src/auth/login.ts"}'))).toBe(true);
    expect(text).toContain("export const login = async (req: Request) => {");
    expect(text).toContain("  return session;");
    expect(text).toMatch(/more lines, ctrl\+o to expand/);
    expect(text).not.toContain("};\n");
    expect(text).not.toContain("Script completed");
    expect(text).not.toContain('"code":');
  });

  it("expands the codemode script and output with the tools key", () => {
    const { view, lines } = viewOf(codemodeSession(), {
      record: agentRecord({ id: "explorer-1" }),
      rows: 400,
    });

    expect(lines()).not.toContain(" export default login;");

    view.handleKey(key("toggleTools"));

    expect(lines()).toContain(" };");
    expect(lines()).toContain(" export default login;");
  });
});

const ARGS = {
  agents: [
    { agent: "scout", task: "find callers" },
    { agent: "scout", task: "find tests" },
  ],
};

const nestedSession = (args: Record<string, unknown>, result: { text: string; details?: RunAgentDetails }) =>
  parseSessionLines(
    [
      line({ role: "user", content: [{ type: "text", text: "Task from main (agent id explorer-1): Nest" }] }),
      line({
        role: "assistant",
        content: [{ type: "toolCall", id: "ra1", name: "run_agent", arguments: args }],
        stopReason: "toolUse",
      }),
      line({
        role: "toolResult",
        toolCallId: "ra1",
        toolName: "run_agent",
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: false,
      }),
    ],
    RECORD_ENTRY,
  );

const nestedSetup = async () => {
  const harness = setup([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    runAgentPlugin,
    agentStatusPlugin,
    agentViewPlugin,
  ]);

  await harness.host
    .tool<RunAgentParams, RunAgentDetails>("run_agent")
    .execute({ agents: [{ agent: "general", task: "nest" }] }, {});
  await flushMicrotasks();

  const parent = harness.registry.list()[0] as AgentRecord;
  const runAgent = harness.runtime
    .child(parent.id)
    .spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as ToolSpec<
    RunAgentParams,
    RunAgentDetails
  >;
  const running = runAgent.execute(ARGS, {});

  await flushMicrotasks();

  const file = join(harness.root, "parent.jsonl");

  const show = (session: SessionRecord, content: string) => {
    writeFileSync(file, content);
    harness.runtime.sessions.set(file, session);
  };

  harness.registry.update(parent.id, { sessionFile: file });

  const text = async () => {
    const { lines } = await harness.open(parent.id);

    return () => lines().join("\n");
  };

  return { running, show, text };
};

describe("agent view nested run_agent calls", () => {
  it("renders nested run_agent calls with the extension's renderer", async () => {
    const harness = setup([
      agentRegistryPlugin,
      agentDefinitionsPlugin,
      runAgentPlugin,
      agentStatusPlugin,
      agentViewPlugin,
    ]);
    const args = { agents: [{ agent: "scout", task: "find callers" }] };
    const session = parseSessionLines(
      [
        line({
          role: "user",
          content: [{ type: "text", text: "Task from main (agent id explorer-1): Nest" }],
        }),
        line({
          role: "assistant",
          content: [{ type: "toolCall", id: "ra1", name: "run_agent", arguments: args }],
          stopReason: "toolUse",
        }),
        line({
          role: "toolResult",
          toolCallId: "ra1",
          toolName: "run_agent",
          content: [{ type: "text", text: "1 agent started" }],
          isError: false,
        }),
      ],
      RECORD_ENTRY,
    );
    const record = closedAgent(harness, session);
    const spec = harness.host.tools.get("run_agent") as unknown as { renderCall: () => string };
    const runAgentSpy = vi.spyOn(spec, "renderCall");
    const { view } = await harness.open(record.id);
    const text = plainLines(view.render(100)).join("\n");

    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining(args),
      expect.anything(),
      expect.anything(),
    );
    expect(text).not.toContain('"agents": [');
  });

  it("draws a nested call with its live rows and no key hint", async () => {
    const { running, show, text } = await nestedSetup();

    show(nestedSession(ARGS, await running), "written");

    const shown = (await text())();

    expect(shown).toContain(" ◌ 2 scout agents");
    expect(shown).not.toContain("to manage");
    expect(shown).not.toContain("to list");
    expect(shown).toContain("scout  find callers");
    expect(shown).toContain("scout  find tests");
    expect(shown).toContain("Starting");
  });
});

const PAYLOAD = {
  model: "provider/model",
  system: "You are explorer…",
  tools: [
    {
      name: "read",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
  messages: [{ role: "user", content: "Task from main (agent id explorer-1): Map the auth module" }],
};

const PAYLOAD_LINES = JSON.stringify(PAYLOAD, null, 2).split("\n").length;

const requestSession = (entries = 1, recorded = true) =>
  parseSessionLines(
    [
      line({
        role: "user",
        content: [{ type: "text", text: "Task from main (agent id explorer-1): Map the auth module" }],
      }),
      ...(recorded
        ? [JSON.stringify({ type: "custom", customType: RECORD_ENTRY, data: { providerPayload: PAYLOAD } })]
        : []),
      ...Array.from({ length: entries }, (_, index) =>
        line({ role: "assistant", content: [{ type: "text", text: `Reply ${index}.` }], stopReason: "stop" }),
      ),
    ],
    RECORD_ENTRY,
  );

describe("agent view request block", () => {
  const openRecord = agentRecord({ id: "explorer-1" });
  const closedRecord = agentRecord({ id: "explorer-1", state: "done", endedAt: 0 });

  it("copies the request and confirms it in the notice row", async () => {
    const copy = vi.fn(async (_text: string) => {});
    const { view, lines } = viewOf(requestSession(), {
      record: openRecord,
      copy,
      theme: tokenTaggingTheme(),
    });

    view.handleKey(char("c"));
    await flushMicrotasks();

    expect(lines().at(-3)).toBe(" <success>Copied the request</>");

    view.handleKey(char("r"));

    expect(lines().at(-3)).toBe("");
  });

  it("reports why the copy failed", async () => {
    const copy = vi.fn(async (_text: string) => {
      throw new Error("Clipboard unavailable");
    });
    const { view, lines } = viewOf(requestSession(), { record: openRecord, copy });

    view.handleKey(char("c"));
    await flushMicrotasks();

    expect(lines().at(-3)).toBe(" Copy failed: Clipboard unavailable");
  });

  it("ignores c without a request", async () => {
    const copy = vi.fn(async (_text: string) => {});
    const { view, lines } = viewOf(requestSession(1, false), { record: openRecord, copy });
    const before = lines();

    view.handleKey(char("c"));
    await flushMicrotasks();

    expect(copy).not.toHaveBeenCalled();
    expect(lines()).toEqual(before);
  });

  it("shows the task as the first transcript item", () => {
    const { lines } = viewOf(requestSession(), { record: openRecord });
    const all = lines();

    expect(firstTextAfter(all, requestIndex(all))).toBe(
      " Task from main (agent id explorer-1): Map the auth module",
    );
  });

  it("shows the request collapsed on open", () => {
    const { lines } = viewOf(requestSession(), { record: openRecord });
    const all = lines();

    expect(all[all.indexOf(RULE(100)) + 1]).toBe(` Request · ${PAYLOAD_LINES} lines (r to expand)`);
    expect(all.join("\n")).not.toContain('"model": "provider/model"');
    expect(lines(120).at(-2)).toContain(
      "x to stop · r to show the request · ctrl+o to expand tools · c to copy request",
    );
  });

  it("leaves a blank line under the collapsed request, apart from the task box padding", () => {
    const { view } = viewOf(requestSession(), {
      record: openRecord,
      theme: tokenTaggingTheme({ bold: true }),
    });
    const raw = plainLines(view.render(100));
    const at = raw.findIndex((entry) => entry.includes("Request · "));

    expect(raw[at + 1]).toBe("");
    expect(raw[at + 2]).toBe("");
    expect(raw[at + 3]).toContain("Task from");
  });

  it("expands the request with r and scrolls to the top", () => {
    const { view, lines, update } = viewOf(requestSession(30), { record: openRecord, rows: 10 });

    lines();
    view.handleKey(char("r"));

    const all = lines();
    const rule = all.indexOf(RULE(100));

    expect(all[rule + 1]).toBe(` Request · ${PAYLOAD_LINES} lines (r to collapse)`);
    expect(all[rule + 2]).toBe("   {");
    expect(all.at(-2)).toMatch(/ 1-\d+\/\d+ · end to follow$/);
    expect(all.at(-2)).toContain("r to hide the request");

    update({ session: requestSession(31) });

    expect(lines().slice(0, -3)).toEqual(all.slice(0, -3));
  });

  it("collapses the request with r and returns to the tail, following", () => {
    const { view, lines, update } = viewOf(requestSession(30), { record: openRecord, rows: 10 });

    lines();
    view.handleKey(char("r"));
    lines();
    view.handleKey(char("r"));

    expect(lines().join("\n")).toContain("Reply 29.");
    expect(lines().at(-2)).not.toContain("end to follow");

    update({ session: requestSession(31) });

    expect(lines().join("\n")).toContain("Reply 30.");
  });

  it("collapses to the tail without following for a closed agent", () => {
    const { view, lines } = viewOf(requestSession(30), { record: closedRecord, rows: 10 });

    lines();
    view.handleKey(char("r"));
    lines();
    view.handleKey(char("r"));

    expect(lines().join("\n")).toContain("Reply 29.");
    expect(lines().at(-2)).not.toContain("end to follow");
  });

  it("starts collapsed again on every open", async () => {
    const harness = setup();
    const record = closedAgent(harness, requestSession());

    await harness.host.runCommand("agents", "");

    const { view } = openLastOverlay(harness.host, 60);

    view.handleKey(key("enter"));
    view.handleKey(char("r"));

    expect(plainLines(view.render(100))).toContain(` Request · ${PAYLOAD_LINES} lines (r to collapse)`);

    view.handleKey(key("escape"));

    expect(plainLines(view.render(100)).join("\n")).toContain(record.description);

    view.handleKey(key("enter"));

    expect(plainLines(view.render(100))).toContain(` Request · ${PAYLOAD_LINES} lines (r to expand)`);
  });

  it("says not sent yet while the agent is open without a request", () => {
    const { view, lines } = viewOf(requestSession(1, false), { record: openRecord });
    const before = lines();

    expect(before).toContain(" Request · not sent yet");
    expect(before.at(-2)).not.toMatch(/ r (request|hide request)/);

    view.handleKey(char("r"));

    expect(lines()).toEqual(before);
  });

  it("says not recorded for a closed agent without a request", async () => {
    const harness = setup([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin], {
      beforeStart: ({ host, runtime }) => {
        const dir = join(agentsDirFor(host.info), "explorer-past");
        const file = join(dir, "session.jsonl");

        mkdirSync(dir, { recursive: true });
        writeFileSync(file, "");
        writeFileSync(
          join(dir, MANIFEST_FILE),
          JSON.stringify({
            id: "explorer-past",
            agent: "scout",
            description: "old",
            state: "done",
            sessionFile: file,
          }),
        );
        runtime.sessions.set(file, requestSession(1, false));
      },
    });

    const { view } = await harness.openView("explorer-past");
    const before = plainLines(view.render(100));

    expect(before).toContain(" Request · not recorded");
    expect(before.at(-2)).not.toMatch(/ r (request|hide request)/);

    view.handleKey(char("r"));

    expect(plainLines(view.render(100))).toEqual(before);
  });

  it("leaves the request alone on the tools key", () => {
    const { view, lines } = viewOf(requestSession(), { record: openRecord });

    view.handleKey(key("toggleTools"));

    expect(lines()).toContain(` Request · ${PAYLOAD_LINES} lines (r to expand)`);

    view.handleKey(char("r"));

    const expanded = lines();

    view.handleKey(key("toggleTools"));

    const all = lines();
    const json = (entries: string[]) => entries.filter((entry) => entry.startsWith("   "));

    expect(json(all)).toEqual(json(expanded));
  });
});

describe("agent view clicks", () => {
  const rowOf = (lines: string[], text: string) => lines.findIndex((entry) => entry.includes(text));

  const expanders = (lines: string[]) => lines.filter((entry) => entry.includes("more lines")).length;

  it("opens one tool call on a click and closes it on a second click", () => {
    const { view, lines } = viewOf(grepSession(), {
      record: agentRecord({ id: "explorer-1", state: "done" }),
    });
    const before = lines();

    expect(expanders(before)).toBe(2);
    expect(view.handleClick?.(5, rowOf(before, "alpha 3"))).toBe(true);

    const opened = lines();

    expect(opened.join("\n")).toContain("alpha 39");
    expect(opened.join("\n")).not.toContain("beta 39");
    expect(expanders(opened)).toBe(1);
    expect(view.handleClick?.(5, rowOf(opened, "alpha 3"))).toBe(true);
    expect(lines()).toEqual(before);
  });

  it("maps the row through the header and the scroll position", () => {
    const { view, lines } = viewOf(grepSession(), {
      rows: 30,
      record: agentRecord({ id: "explorer-1", state: "done" }),
    });

    lines();
    view.handleKey(key("home"));
    view.handleWheel?.(8);

    const before = lines();
    const row = rowOf(before, "alpha 10");

    expect(before.at(-2)).toMatch(/ 9-29\/47$/);
    expect(row).toBeGreaterThan(0);
    expect(view.handleClick?.(5, row)).toBe(true);
    expect(lines().at(-2)).toMatch(/ 9-29\/71$/);
    expect(lines()[row]).toBe(before[row]);
  });

  it("ignores clicks on the header, the rule, the hint and the padding", () => {
    const { view, lines } = viewOf(grepSession(), {
      rows: 200,
      record: agentRecord({ id: "explorer-1", state: "done" }),
    });
    const before = lines();
    const rule = before.indexOf(RULE(100));
    const rows = [0, 1, 2, rule, before.length - 2, before.length - 4];

    expect(rows.map((row) => view.handleClick?.(5, row))).toEqual(rows.map(() => false));
    expect(lines()).toEqual(before);
  });

  it("toggles the request on a click on its line, like r", () => {
    const { view, lines } = viewOf(grepSession(), {
      record: agentRecord({ id: "explorer-1", state: "done" }),
    });
    const row = requestIndex(lines());

    expect(view.handleClick?.(3, row)).toBe(true);
    expect(lines()[row]).toMatch(/^ Request · \d+ lines \(r to collapse\)$/);
    expect(lines().at(-2)).toContain("r to hide the request");
    expect(view.handleClick?.(3, row + 1)).toBe(false);
    expect(view.handleClick?.(3, row)).toBe(true);
    expect(lines()[row]).toMatch(/^ Request · \d+ lines \(r to expand\)$/);
  });

  it("keeps the clicked call in place instead of following the tail", () => {
    const { view, lines } = viewOf(grepSession(), { rows: 30, record: agentRecord({ id: "explorer-1" }) });
    const before = lines();
    const position = before.at(-2)?.match(/ (\d+)-\d+\/\d+$/)?.[1];
    const row = rowOf(before, "beta 3");

    expect(before.at(-2)).not.toContain("end to follow");
    expect(view.handleClick?.(5, row)).toBe(true);

    const after = lines();

    expect(after[row]).toBe(before[row]);
    expect(after.at(-2)).toContain(`${position}-`);
    expect(after.at(-2)).toContain("end to follow");
  });
});
