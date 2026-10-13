import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord, ThemeLike, ViewComponent } from "../../../../../core/adapter/contract.ts";
import {
  parseSessionLines,
  promptRecordEntry,
  readSessionFile,
} from "../../../../../core/adapter/session-file.ts";
import { initRenderTheme } from "../../../../../core/test/adapter/render-theme.ts";
import { flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import { displayWidth } from "../../../src/components/format.ts";
import { agentsDirFor, MANIFEST_FILE, NAMESPACE } from "../../../src/model/paths.ts";
import type { AgentRecord, AgentViewOrigin } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import type { ViewData } from "../../../src/plugins/agent-view/loader.ts";
import { createAgentView, headerLines } from "../../../src/plugins/agent-view/view.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";
import { char, fakeOverlayApi, key, plain, recordingTheme } from "../../helpers/overlay.ts";
import { agentRecord } from "../../helpers/records.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "recorded-session.jsonl");

const RECORD_ENTRY = promptRecordEntry(NAMESPACE);

initRenderTheme();

const views: ViewComponent[] = [];

const track = <T extends ViewComponent>(view: T): T => {
  views.push(view);

  return view;
};

afterEach(() => {
  views.splice(0).forEach((view) => {
    view.dispose?.();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const fixture = () => readSessionFile(FIXTURE, RECORD_ENTRY);

const setup = (plugins = [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentViewPlugin]) => {
  const harness = createHarness(plugins);
  const registry = harness.services.require("registry");

  const openLast = (rows = 200) => {
    const factory = harness.host.overlays.at(-1);

    if (!factory) {
      throw new Error("no overlay opened");
    }

    const { api, state, transcripts } = fakeOverlayApi(rows);

    return { view: track(factory(api)), state, transcripts };
  };

  const openView = async (args: string, rows = 200) => {
    await harness.host.runCommand("agents", args);

    return openLast(rows);
  };

  const openFrom = async (id: string, from: AgentViewOrigin, rows = 200) => {
    await harness.services.require("agentView").open(id, { from });

    return openLast(rows);
  };

  return { ...harness, registry, openView, openFrom };
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

  const record = harness.registry.create({
    agent: "explorer",
    description: "t",
    callerId: "main",
    depth: 2,
    batchId: "b-x",
    dir: join(harness.root, "agents"),
    contextLimit: 100_000,
  });

  harness.registry.close(record.id, { state: "done", sessionFile: file, ...patch });

  return record;
};

const runningAgent = async (harness = setup()) => {
  const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

  await runAgent.execute({ agents: [{ agent: "explorer", task: "long job" }] }, { update: () => {} });
  await flush();
  harness.host.settle();

  const record = harness.registry.list()[0] as AgentRecord;

  return { harness, record };
};

type ViewOptions = {
  rows?: number;
  record?: AgentRecord;
  from?: AgentViewOrigin;
  stop?: () => Promise<unknown> | undefined;
  width?: number;
  theme?: ThemeLike;
};

const viewOf = (session: SessionRecord | undefined, options: ViewOptions = {}) => {
  const { api, state, transcripts } = fakeOverlayApi(options.rows ?? 200, options.theme);
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
        from: options.from ?? "command",
        tools: [],
        reserveTokens: 0,
        stop: options.stop ?? (() => undefined),
        watch: (_tickMs, onChange) => {
          changed = onChange;
          return () => {};
        },
        leave: () => {
          left.count += 1;
        },
      },
      api,
    ),
  );

  const update = (next: Partial<ViewData>) => {
    current = { ...current, ...next };
    changed();
  };

  const lines = (width = options.width ?? 100) => plain(view.render(width));

  return { view, state, transcripts, update, lines, left, loads: () => loads };
};

const fixtureWithout = (count: number): SessionRecord => {
  const session = fixture();

  return { ...session, items: session.items.slice(0, session.items.length - count) };
};

const waitForRefresh = () => new Promise<void>((done) => setTimeout(done, 350));

const RULE = (width: number) => "─".repeat(width);

const requestIndex = (lines: string[]) => lines.findIndex((line) => /^ [▸▾] Request/.test(line));

const firstTextAfter = (lines: string[], index: number) => lines.slice(index + 1).find((line) => line !== "");

describe("agent view", () => {
  it("opens for a closed agent by reading its session file", async () => {
    const harness = setup();
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute({ agents: [{ agent: "explorer", task: "list agents" }] }, { update: () => {} });
    await flush();

    const record = harness.registry.list()[0] as AgentRecord;
    const child = harness.runtime.child(record.id);

    harness.host.settle();
    child.finish("Three files.");
    await flush();

    harness.runtime.sessions.set(String(child.sessionFile), fixture());
    mkdirSync(record.dir, { recursive: true });
    writeFileSync(String(child.sessionFile), "");

    const { view } = await harness.openView(record.id);
    const lines = plain(view.render(100));

    expect(lines[0]).toBe("");
    expect(lines[1]).toBe(" ✓ explorer › list agents");
    expect(lines[2]).toBe(` done · ${record.model} · id ${record.id}`);
    expect(lines[3]).toMatch(/^ \d+ tool uses? · /);
    expect(lines[4]).toBe(RULE(100));
    expect(lines[5]).toMatch(/^ ▸ Request · \d+ lines$/);
    expect(lines).toContain(" Three files: explorer.md, implementer.md, reviewer.md.");
    expect(lines.at(-2)?.startsWith(" esc to close · r request · ctrl+o tool detail")).toBe(true);
    expect(lines.at(-3)).toBe("");
    expect(lines.at(-1)).toBe("");
  });

  it("renders the transcript with pi's message and tool components", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const lines = plain(view.render(100));
    const transcript = lines.slice(requestIndex(lines) + 1, -3);

    expect(transcript.join("\n").trimEnd()).toMatchSnapshot();
  });

  it("toggles tool detail with the tools-expand key", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const collapsed = plain(view.render(100));

    view.handleKey(key("toggleTools"));

    const expanded = plain(view.render(100));

    expect(collapsed).not.toContain(" - One finding per line.");
    expect(expanded).toContain(" - One finding per line.");

    view.handleKey(key("toggleTools"));

    expect(plain(view.render(100))).toEqual(collapsed);
  });

  it("ignores Enter, Space, Tab, c and v", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view, state } = await harness.openView(record.id);
    const before = plain(view.render(100));

    view.handleKey(key("enter"));
    view.handleKey(key("space"));
    view.handleKey(key("tab"));
    view.handleKey(char("c"));
    view.handleKey(char("v"));

    expect(plain(view.render(100))).toEqual(before);
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

    expect(lines()[5]).toBe(" ▸ Request · 12 lines");
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

  it("starts a fresh transcript when the view follows a successor with another session file", () => {
    const full = fixture();
    const head = { ...full, items: full.items.slice(0, 2) };
    const tail = { ...full, items: full.items.slice(-2) };
    const first = agentRecord({ id: "explorer-1", state: "done", endedAt: 0, sessionFile: "/first.jsonl" });
    const { view, update, lines, transcripts } = viewOf(head, { rows: 40, record: first });
    const body = (all: string[]) => all.slice(6).join("\n");
    const before = body(lines());

    view.handleKey(char("r"));

    expect(lines()[5]).toBe(" ▾ Request · 12 lines");

    update({ record: { ...first, sessionFile: "/other.jsonl" }, session: tail });

    const after = lines();

    expect(after[5]).toBe(" ▸ Request · 12 lines");
    expect(body(after)).not.toEqual(before);
    expect(body(after)).toEqual(body(viewOf(tail, { rows: 40, record: first }).lines()));
    expect(transcripts).toHaveLength(2);
  });

  it("enters grace on the first x and closes on the second", async () => {
    const { harness, record } = await runningAgent();
    const { view } = await harness.openView(record.id);

    expect(plain(view.render(100))[2]).toContain("running");
    expect(plain(view.render(100)).at(-2)).toContain("x to stop");

    view.handleKey(char("x"));
    await flush();

    expect(harness.registry.get(record.id)?.state).toBe("grace");
    expect(plain(view.render(100)).at(-2)).toContain("x to close now");

    view.handleKey(char("x"));
    await flush();

    expect(harness.registry.get(record.id)?.state).toBe("stopped");
    expect(harness.runtime.child(record.id).aborted).toBe(true);
  });

  it("never routes anything from the UI", async () => {
    const { harness, record } = await runningAgent();
    const route = vi.spyOn(harness.services.require("runner"), "route");
    const { view } = await harness.openView(record.id);

    Array.from("hello").forEach((value) => {
      view.handleKey(char(value));
    });
    view.handleKey(key("enter"));
    await flush();

    expect(route).not.toHaveBeenCalled();
    expect(harness.runtime.child(record.id).messages).toEqual([]);
    expect(plain(view.render(100)).join("\n")).not.toContain("hello");
    expect(plain(view.render(100)).join("\n")).not.toContain("(type a message)");
  });

  it("writes no view state file", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);

    view.handleKey(char("v"));
    view.render(100);

    expect(existsSync(join(harness.host.info.agentDir, "pi-subagents-view.json"))).toBe(false);
  });

  it("shows the worktree and branch under the stats", async () => {
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
    const lines = plain(view.render(100));

    expect(lines[4]).toBe(
      " worktree: /project/.pi/worktrees/explorer-1-abc (branch pi-agents/explorer-1-abc)",
    );
    expect(lines[5]).toBe(RULE(100));

    harness.registry.update(record.id, { worktree: { ...worktree, cleanup: "branch kept" } });

    const again = await harness.openView(record.id);

    expect(plain(again.view.render(100))[4]).toBe(" worktree: removed; branch pi-agents/explorer-1-abc kept");
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
    const table: [Partial<AgentRecord>, string[]][] = [
      [
        { state: "queued" },
        [" ○ explorer › Map the auth module", " queued · provider/model · id explorer-1"],
      ],
      [
        { state: "running" },
        [" ⠋ explorer › Map the auth module", " running · provider/model · id explorer-1"],
      ],
      [
        { state: "grace" },
        [" ◐ explorer › Map the auth module", " stopping · provider/model · id explorer-1"],
      ],
      [
        { state: "done", endedAt: 0 },
        [" ✓ explorer › Map the auth module", " done · provider/model · id explorer-1"],
      ],
      [
        { state: "failed", endedAt: 0, error: "tests failed twice\nstack" },
        [" ✗ explorer › Map the auth module", " failed · provider/model · id explorer-1"],
      ],
      [
        { state: "stopped", endedAt: 0 },
        [" ■ explorer › Map the auth module", " stopped · provider/model · id explorer-1"],
      ],
      [
        { state: "handoff", endedAt: 0, handoffPath: "/tmp/h.md" },
        [" ↪ explorer › Map the auth module", " handed off · provider/model · id explorer-1"],
      ],
    ];

    table.forEach(([patch, expected]) => {
      const lines = header(base(patch));

      expect(lines.slice(0, 2)).toEqual(expected);
      expect(lines[2]).toBe(" 0 tool uses · 0s");
    });

    expect(header(base({ state: "failed", error: "tests failed twice\nstack" }))[3]).toBe(
      " error: tests failed twice",
    );
    expect(header(base({ state: "handoff", handoffPath: "/tmp/h.md" }))[3]).toBe(" handoff: /tmp/h.md");
    expect(header(base({ state: "handoff", handoffPath: "/tmp/h.md", error: "missing Status" }))[3]).toBe(
      " handoff: /tmp/h.md (invalid: missing Status)",
    );

    const painted = header(base({ state: "done", endedAt: 0 }), recordingTheme);

    expect(painted[0]).toBe(" <success>✓</> <b>explorer</b> › Map the auth module");
    expect(painted[1]).toBe(" <dim>done · provider/model · id explorer-1</>");
  });

  it("names the agent and the description on line 1 and the id only on line 2", () => {
    expect(header(base({ model: undefined }))[1]).toBe(" running · model n/a · id explorer-1");
    expect(header(base({ chainIndex: 2 }))[0]).toBe(" ⠋ explorer #2 › Map the auth module");

    const lines = header(base());

    expect(lines[0]).not.toContain("explorer-1");
    expect(lines[1]).toContain("explorer-1");
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
      expect(displayWidth(line)).toBeLessThanOrEqual(39);
    });
    expect(lines[0]).toMatch(/ › d{8,}…$/);
    expect(lines.at(-1)).toBe(RULE(40));
  });

  it("omits zero tokens and an unknown ctx", () => {
    const record = base({
      toolCalls: 4,
      tokens: 0,
      state: "done",
      startedAt: 0,
      endedAt: 65_000,
      contextLimit: 0,
    });

    expect(header(record)[2]).toBe(" 4 tool uses · 1m 5s");
    expect(header({ ...record, tokens: 12_300 })[2]).toBe(" 4 tool uses · 12.3k tokens · 1m 5s");
  });

  it("shows the chain index and chain links", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const record = base({ chainIndex: 2, predecessorId: "explorer-0001", model: undefined });
    const { lines } = viewOf(fixture(), { record });

    expect(lines()[1]).toBe(" ⠋ explorer #2 › Map the auth module");
    expect(lines()[2]).toBe(" running · model n/a · id explorer-1");

    const chained = headerLines({ record, chain: ["explorer-0001", record.id] }, plainTheme, 100, 0, 0);

    expect(chained).toContain(" chain: explorer-0001 → explorer-1 (2 sessions)");
  });
});

describe("agent view hint", () => {
  const hintOf = (record: AgentRecord, options: { from?: AgentViewOrigin; session?: SessionRecord } = {}) =>
    viewOf("session" in options ? options.session : fixture(), { record, from: options.from, rows: 400 });

  it("writes the hint per state and origin", () => {
    const open = agentRecord({ id: "explorer-1" });
    const grace = agentRecord({ id: "explorer-1", state: "grace" });
    const closed = agentRecord({ id: "explorer-1", state: "done", endedAt: 0 });
    const noRequest = { ...fixture(), prompt: { ...fixture().prompt, providerPayload: undefined } };
    const hint = (view: ReturnType<typeof hintOf>) => (view.lines().at(-2) ?? "").replace(/ {2,}\S+$/, "");

    expect(hint(hintOf(open))).toBe(" esc to close · x to stop · r request · ctrl+o tool detail");
    expect(hint(hintOf(closed, { from: "list" }))).toBe(" esc to go back · r request · ctrl+o tool detail");
    expect(hint(hintOf(open, { session: noRequest }))).toBe(" esc to close · x to stop · ctrl+o tool detail");

    const expanded = hintOf(grace, { from: "list" });

    expanded.view.handleKey(char("r"));

    expect(hint(expanded)).toBe(" esc to go back · x to close now · r hide request · ctrl+o tool detail");

    [open, grace, closed].forEach((record) => {
      expect(hintOf(record).lines().at(-2)).not.toContain("↑/↓");
    });

    const wide = hintOf(closed).view.render(100).at(-2) ?? "";

    expect(plain([wide])[0]).toMatch(/ 1-\d+\/\d+$/);
    expect(displayWidth(wide)).toBe(99);
  });

  it("drops the position when it does not fit", () => {
    const narrow = viewOf(fixture(), { record: agentRecord({ id: "explorer-1" }), width: 40 });
    const hintLine = narrow.lines().at(-2) ?? "";

    expect(hintLine).toBe(" esc to close · x to stop · r request…");
    expect(displayWidth(hintLine)).toBe(38);

    const items = Array.from({ length: 900 }, (_, index) => ({
      kind: "user" as const,
      text: `line ${index}`,
    }));
    const long = viewOf(
      { ...fixture(), items },
      { record: agentRecord({ id: "explorer-1", state: "grace" }), from: "list", rows: 20, width: 80 },
    );

    long.view.handleKey(char("r"));
    long.view.handleKey(key("home"));

    expect(long.lines().at(-2)).toBe(
      " esc to go back · x to close now · r hide request · ctrl+o tool detail",
    );
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

          const lines = plain(view.render(width));
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
            expect(displayWidth(line)).toBeLessThanOrEqual(width - 1);
          });
        });
      });
    });
  });
});

describe("agent view body", () => {
  it("draws no Request line on a load error", async () => {
    const { harness, record } = await runningAgent();
    const { api } = fakeOverlayApi(30, recordingTheme);

    await harness.services.require("agentView").open(record.id, { from: "command" });

    const view = track((harness.host.overlays.at(-1) ?? (() => ({}) as never))(api));
    const lines = view.render(100);
    const text = plain(lines);

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
    const harness = setup();
    const record = closedAgent(harness);
    const readSession = vi.spyOn(harness.runtime, "readSession");
    const { view } = await harness.openView(record.id);

    view.render(100);
    harness.registry.update(record.id, { tokens: 1 });
    await waitForRefresh();
    harness.registry.update(record.id, { tokens: 2 });
    await waitForRefresh();
    view.render(100);

    expect(readSession).toHaveBeenCalledTimes(1);

    writeFileSync(String(record.sessionFile), "{}\n");
    harness.registry.update(record.id, { tokens: 3 });
    await waitForRefresh();

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

    view.handleKey(char("x"));
    await flush();

    expect(lines().at(-3)).toBe(" stop failed: runner gone");
    expect(lines().at(-4)).toBe("");

    view.handleKey(char("x"));
    view.dispose?.();
    finishStop();
    await flush();

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
    const harness = createHarness(
      [agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin, agentViewPlugin],
      { stopGraceSeconds: 0 },
    );
    const registry = harness.services.require("registry");
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute(
      { agents: [{ agent: "explorer", task: "map the auth flow" }] },
      { update: () => {} },
    );
    await flush();
    harness.host.settle();

    const first = registry.list()[0] as AgentRecord;

    await harness.host.runCommand("agents", first.id);

    const view = track((harness.host.overlays.at(-1) ?? (() => ({}) as never))(fakeOverlayApi(200).api));

    harness.runtime
      .child(first.id)
      .turn({ tokens: first.contextLimit + 500, window: 1_000_000, percent: 20 });
    await flush();

    mkdirSync(join(first.handoffPath, ".."), { recursive: true });
    writeFileSync(first.handoffPath, handoffText);
    harness.runtime.child(first.id).finish(first.handoffPath);
    await flush();
    await waitForRefresh();

    const second = registry.get(first.id)?.successorId as string;
    const lines = plain(view.render(200));

    expect(second).toBeDefined();
    expect(lines[1]).toMatch(/^ \S explorer #2 › /);
    expect(lines[2]?.endsWith(`id ${second}`)).toBe(true);
    expect(lines).toContain(` chain: ${first.id} → ${second} (2 sessions) · opened ${first.id}`);
    expect(lines.at(-2)).toContain("x to stop");
    expect(lines.join("\n")).not.toContain("(type a message)");

    view.handleKey(char("x"));
    await flush();

    expect(registry.get(second)?.state).toBe("stopped");
  });

  it("refreshes the header stats with the live turn context", async () => {
    const { harness, record } = await runningAgent();
    const { view } = await harness.openView(record.id);

    harness.runtime.child(record.id).turn({ tokens: 85_000, window: 200_000, percent: 42 });
    await flush();
    await waitForRefresh();

    expect(plain(view.render(100))[3]).toMatch(/ · 85% ctx$/);
  });
});

describe("agent view past sessions", () => {
  const writeManifest = (harness: Harness, manifest: Record<string, unknown>) => {
    const dir = join(agentsDirFor(harness.host.info), String(manifest.id));

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, MANIFEST_FILE),
      typeof manifest.raw === "string" ? manifest.raw : JSON.stringify(manifest),
    );

    return dir;
  };

  const openFromManifest = async (manifest: Record<string, unknown>, session: SessionRecord = fixture()) => {
    const harness = setup([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin]);
    const dir = writeManifest(harness, { description: "old", state: "done", ...manifest });
    const file = join(dir, "session.jsonl");

    writeFileSync(file, "");
    writeManifest(harness, { description: "old", state: "done", sessionFile: file, ...manifest });
    harness.runtime.sessions.set(file, session);

    const { view } = await harness.openView(String(manifest.id));

    return plain(view.render(100));
  };

  it("opens from the manifest with the definition's limit", async () => {
    const lines = await openFromManifest({ id: "explorer-dead", agent: "explorer" });

    expect(lines[3]).toMatch(/ · 2% ctx$/);
  });

  it("prefers the limit stored in the manifest, and shows no ctx without a known limit", async () => {
    const stored = await openFromManifest({ id: "explorer-old", agent: "explorer", contextLimit: 70_000 });
    const gone = await openFromManifest({ id: "removed-old", agent: "removed" });

    expect(stored[3]).toMatch(/ · 3% ctx$/);
    expect(gone[3]).not.toContain("ctx");
  });

  it("shows persisted counters for agents known only from their manifest", async () => {
    const lines = await openFromManifest({
      id: "explorer-past",
      agent: "explorer",
      toolCalls: 4,
      tokens: 12_300,
      turns: 3,
      startedAt: 0,
      endedAt: 65_000,
    });

    expect(lines[3]).toBe(" 4 tool uses · 12.3k tokens · 1m 5s · 2% ctx");
  });

  it("shows 0 tool uses for a manifest written before counters were stored", async () => {
    const lines = await openFromManifest({
      id: "explorer-older",
      agent: "explorer",
      startedAt: 0,
      endedAt: 3_000,
    });

    expect(lines[3]).toBe(" 0 tool uses · 3s · 2% ctx");
  });

  it("follows a chain of an earlier session to its last link", async () => {
    const harness = setup();
    const file = join(harness.root, "old-2.jsonl");

    writeFileSync(file, "");
    harness.runtime.sessions.set(file, fixture());
    writeManifest(harness, {
      id: "explorer-old1",
      agent: "explorer",
      description: "old",
      state: "handoff",
      successorId: "explorer-old2",
    });
    writeManifest(harness, {
      id: "explorer-old2",
      agent: "explorer",
      description: "old",
      state: "done",
      chainIndex: 2,
      predecessorId: "explorer-old1",
      sessionFile: file,
    });

    const { view } = await harness.openView("explorer-old1");
    const lines = plain(view.render(200));

    expect(lines[1]).toContain("explorer #2 › ");
    expect(lines[2]?.endsWith("id explorer-old2")).toBe(true);
    expect(lines).toContain(" chain: explorer-old1 → explorer-old2 (2 sessions) · opened explorer-old1");
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

describe("agent view codemode and nested tools", () => {
  it("renders codemode calls with pi's renderer", () => {
    const { lines } = viewOf(codemodeSession(), { record: agentRecord({ id: "explorer-1" }), rows: 400 });
    const all = lines();
    const text = all.join("\n");
    const block = all.slice(all.indexOf(" codemode"), -3).join("\n").trimEnd();

    expect(all).toContain(" codemode");
    expect(all).toContain(' const hits = await tools.grep({ pattern: "login", path: "src" });');
    expect(all.some((entry) => entry.startsWith(' ✓ grep {"pattern":"login","path":"src"}'))).toBe(true);
    expect(all.some((entry) => entry.startsWith(' ✓ read {"path":"src/auth/login.ts"}'))).toBe(true);
    expect(text).toContain("export const login = async (req: Request) => {");
    expect(text).toContain("  return session;");
    expect(text).toContain("more lines");
    expect(text).not.toContain("};\n");
    expect(text).not.toContain("Script completed");
    expect(text).not.toContain('"code":');
    expect(block).toMatchSnapshot();
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

  it("renders nested run_agent calls with the extension's renderer", async () => {
    const harness = setup([
      agentRegistryPlugin,
      agentDefinitionsPlugin,
      runAgentPlugin,
      agentStatusPlugin,
      agentViewPlugin,
    ]);
    const args = { agents: [{ agent: "explorer", task: "find callers" }] };
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
    const specs = harness.services.require("tools").list();
    const spies = specs.map((spec) => (spec.renderCall ? vi.spyOn(spec, "renderCall") : undefined));
    const runAgentSpy = spies[specs.findIndex((spec) => spec.name === "run_agent")];
    const { view, transcripts } = await harness.openFrom(record.id, "command");
    const text = plain(view.render(100)).join("\n");

    expect(transcripts[0]?.tools?.map((spec) => spec.name)).toEqual(
      expect.arrayContaining(["run_agent", "message_agent", "agent_status"]),
    );
    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining(args),
      expect.anything(),
      expect.anything(),
    );
    expect(text).not.toContain('"agents": [');
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

    expect(all[all.indexOf(RULE(100)) + 1]).toBe(` ▸ Request · ${PAYLOAD_LINES} lines`);
    expect(all.join("\n")).not.toContain('"model": "provider/model"');
    expect(all.at(-2)).toContain("x to stop · r request · ctrl+o tool detail");
  });

  it("expands the request with r and scrolls to the top", () => {
    const { view, lines, update } = viewOf(requestSession(30), { record: openRecord, rows: 10 });

    lines();
    view.handleKey(char("r"));

    const all = lines();
    const rule = all.indexOf(RULE(100));

    expect(all[rule + 1]).toBe(` ▾ Request · ${PAYLOAD_LINES} lines`);
    expect(all[rule + 2]).toBe("   {");
    expect(all.at(-2)).toMatch(/ 1-\d+\/\d+ · end to follow$/);
    expect(all.at(-2)).toContain("r hide request");

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

    const { view } = (() => {
      const factory = harness.host.overlays.at(-1);
      const { api } = fakeOverlayApi(60);

      return { view: track((factory ?? (() => ({}) as never))(api)) };
    })();

    view.handleKey(key("enter"));
    view.handleKey(char("r"));

    expect(plain(view.render(100))).toContain(` ▾ Request · ${PAYLOAD_LINES} lines`);

    view.handleKey(key("escape"));

    expect(plain(view.render(100)).join("\n")).toContain(record.description);

    view.handleKey(key("enter"));

    expect(plain(view.render(100))).toContain(` ▸ Request · ${PAYLOAD_LINES} lines`);
  });

  it("says not sent yet while the agent is open without a request", () => {
    const { view, lines } = viewOf(requestSession(1, false), { record: openRecord });
    const before = lines();

    expect(before).toContain(" ▸ Request · not sent yet");
    expect(before.at(-2)).not.toMatch(/ r (request|hide request)/);

    view.handleKey(char("r"));

    expect(lines()).toEqual(before);
  });

  it("says not recorded for a closed agent without a request", async () => {
    const harness = setup([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin]);
    const dir = join(agentsDirFor(harness.host.info), "explorer-past");
    const file = join(dir, "session.jsonl");

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "");
    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify({
        id: "explorer-past",
        agent: "explorer",
        description: "old",
        state: "done",
        sessionFile: file,
      }),
    );
    harness.runtime.sessions.set(file, requestSession(1, false));

    const { view } = await harness.openView("explorer-past");
    const before = plain(view.render(100));

    expect(before).toContain(" ▸ Request · not recorded");
    expect(before.at(-2)).not.toMatch(/ r (request|hide request)/);

    view.handleKey(char("r"));

    expect(plain(view.render(100))).toEqual(before);
  });

  it("leaves the request alone on the tools key", () => {
    const { view, lines } = viewOf(requestSession(), { record: openRecord });

    view.handleKey(key("toggleTools"));

    expect(lines()).toContain(` ▸ Request · ${PAYLOAD_LINES} lines`);

    view.handleKey(char("r"));

    const expanded = lines();

    view.handleKey(key("toggleTools"));

    const all = lines();
    const json = (entries: string[]) => entries.filter((entry) => entry.startsWith("   "));

    expect(json(all)).toEqual(json(expanded));
  });

  it("renders the expanded request as plain indented text", () => {
    const { view } = viewOf(requestSession(), { record: openRecord, theme: recordingTheme });

    view.handleKey(char("r"));

    const raw = plain(view.render(100));
    const start = raw.findIndex((entry) => entry.includes("▾ Request"));
    const end = raw.indexOf("", start);

    expect(raw[start]).toBe(` <dim>▾ Request · ${PAYLOAD_LINES} lines</>`);
    expect(raw.slice(start + 1, end).every((entry) => !entry.includes("<"))).toBe(true);
    expect(raw.slice(start, end)).toMatchSnapshot();
  });
});
