import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { KeyPress, OverlayApi, SessionRecord } from "../../../../../core/adapter/contract.ts";
import { createScrollPane, createTranscriptPane } from "../../../../../core/adapter/pi-ui.ts";
import {
  parseSessionLines,
  promptRecordEntry,
  readSessionFile,
} from "../../../../../core/adapter/session-file.ts";
import { initRenderTheme } from "../../../../../core/test/adapter/render-theme.ts";
import { createFakeInputPane, flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import { renderSections, setAllCollapsed } from "../../../src/components/collapsible.ts";
import { promptSections } from "../../../src/components/system-prompt-block.ts";
import { agentsDirFor, MANIFEST_FILE, NAMESPACE } from "../../../src/model/paths.ts";
import type { AgentRecord, RouteResult } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { createAgentView } from "../../../src/plugins/agent-view/view.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "recorded-session.jsonl");

const RECORD_ENTRY = promptRecordEntry(NAMESPACE);

initRenderTheme();

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

const fakeApi = (rows = 200) => {
  const state = { closed: false, renders: 0 };
  const requestRender = () => {
    state.renders += 1;
  };

  const api: OverlayApi = {
    theme: plainTheme,
    rows: () => rows,
    close: () => {
      state.closed = true;
    },
    requestRender,
    toolsKey: "ctrl+o",
    wheelScrolling: true,
    createTranscript: () => createTranscriptPane({ requestRender } as never, "/repo"),
    createScroll: () => createScrollPane(requestRender),
    createInput: createFakeInputPane,
  };

  return { api, state };
};

const key = (name: KeyPress["name"], char?: string): KeyPress => ({ name, char });

describe("system prompt block", () => {
  it("renders the recorded prompt, tools, skills, guidelines and provider payload", () => {
    const session = readSessionFile(FIXTURE, RECORD_ENTRY);
    const sections = setAllCollapsed(promptSections(session.prompt), false);
    const rendered = renderSections(sections, 0, plainTheme, (text) => [text]);

    expect(rendered.lines.join("\n")).toMatchSnapshot();
    expect(session.prompt.model).toBe("openai/gpt-6-luna");
  });

  it("lists MCP tools and pi's MCP server section when the child's prompt carried them", () => {
    const system = {
      type: "message",
      message: {
        role: "system",
        sections: { mcp_servers: "MCP servers reached through codemode:\n- mcp__docs (codemode)" },
        toolsAdded: [
          { name: "codemode", description: "Run a script.", parameters: {} },
          { name: "mcp__github__create_issue", description: "Create an issue.", parameters: {} },
        ],
      },
    };

    const session = parseSessionLines([JSON.stringify(system)], RECORD_ENTRY);
    const sections = setAllCollapsed(promptSections(session.prompt), false);
    const text = renderSections(sections, 0, plainTheme, (line) => [line]).lines.join("\n");

    expect(text).toContain("System prompt · mcp_servers");
    expect(text).toContain("- mcp__docs (codemode)");
    expect(text).toContain("Tools (2)");
    expect(text).toContain("mcp__github__create_issue: Create an issue.");
  });

  it("starts collapsed with one header per section", () => {
    const session = readSessionFile(FIXTURE, RECORD_ENTRY);
    const rendered = renderSections(promptSections(session.prompt), 0, plainTheme, (text) => [text]);

    expect(rendered.lines).toEqual([
      "› ▸ System prompt · preamble (1 lines)",
      "  ▸ System prompt · tools (4 lines)",
      "  ▸ System prompt · addendum (4 lines)",
      "  ▸ System prompt · cwd (1 lines)",
      "  ▸ Tools (2) (21 lines)",
      "  ▸ Skills (1) (1 lines)",
      "  ▸ Tool guidelines (1) (1 lines)",
      "  ▸ Provider request (first, as sent) (12 lines)",
    ]);
  });
});

const setup = () => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    runAgentPlugin,
    agentViewPlugin,
  ]);

  const openView = async (args: string, rows = 200) => {
    await harness.host.runCommand("agents", args);

    const factory = harness.host.overlays.at(-1);

    if (!factory) {
      throw new Error("no overlay opened");
    }

    const { api, state } = fakeApi(rows);

    return { view: factory(api), state };
  };

  return { ...harness, openView };
};

const closedAgent = (harness: ReturnType<typeof setup>) => {
  const file = join(harness.root, "recorded.jsonl");

  writeFileSync(file, "");
  harness.runtime.sessions.set(file, readSessionFile(FIXTURE, RECORD_ENTRY));

  const registry = harness.services.require("registry");

  const record = registry.create({
    agent: "explorer",
    description: "t",
    callerId: "main",
    depth: 2,
    batchId: "b-x",
    dir: join(harness.root, "agents"),
    contextLimit: 100_000,
  });

  registry.close(record.id, { state: "done", sessionFile: file });

  return record;
};

const viewDefaults = {
  context: { softRatio: 0.8, reserveTokens: 0, estimate: (text: string) => Math.ceil(text.length / 4) },
  modes: { read: () => "focus" as const, write: () => {} },
};

const viewOf = (session: SessionRecord, rows: number) => {
  const { api, state } = fakeApi(rows);
  let current = session;
  let changed = () => {};

  const harness = setup();
  const record = closedAgent(harness);

  const view = createAgentView(
    {
      ...viewDefaults,
      load: () => ({ record, session: current }),
      stop: () => undefined,
      send: async () => ({ ok: true, delivery: "steer" }),
      subscribe: (onChange) => {
        changed = onChange;
        return () => {};
      },
    },
    api,
  );

  const append = (next: SessionRecord) => {
    current = next;
    changed();
  };

  return { view, state, append };
};

const fixtureWithout = (count: number): SessionRecord => {
  const session = readSessionFile(FIXTURE, RECORD_ENTRY);

  return { ...session, items: session.items.slice(0, session.items.length - count) };
};

describe("agent view", () => {
  it("reuses the rendered prompt block until sections, focus or width change", () => {
    const { api } = fakeApi(40);
    const harness = setup();
    const record = closedAgent(harness);
    const session = readSessionFile(FIXTURE, RECORD_ENTRY);
    const sectionTitles: string[] = [];

    const countingApi: OverlayApi = {
      ...api,
      theme: {
        ...plainTheme,
        bold: (text) => {
          sectionTitles.push(text);
          return text;
        },
      },
    };

    const view = createAgentView(
      {
        ...viewDefaults,
        load: () => ({ record, session }),
        stop: () => undefined,
        send: async () => ({ ok: true, delivery: "steer" }),
        subscribe: () => () => {},
      },
      countingApi,
    );

    const promptTitles = () => sectionTitles.filter((title) => title.startsWith("System prompt")).length;

    view.render(100);

    const firstRender = promptTitles();

    view.render(100);
    view.handleWheel?.(-3);
    view.render(100);

    expect(firstRender).toBeGreaterThan(0);
    expect(promptTitles()).toBe(firstRender);

    view.handleKey(key("tab"));
    view.render(100);

    expect(promptTitles()).toBe(firstRender * 2);

    view.render(80);

    expect(promptTitles()).toBe(firstRender * 3);
  });

  it("opens for a closed agent by reading its session file", async () => {
    const harness = setup();
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute({ agents: [{ agent: "explorer", task: "list agents" }] }, { update: () => {} });
    await flush();

    const record = harness.services.require("registry").list()[0];
    const child = harness.runtime.child(record.id);

    harness.host.settle();
    child.finish("Three files.");
    await flush();

    harness.runtime.sessions.set(String(child.sessionFile), readSessionFile(FIXTURE, RECORD_ENTRY));
    mkdirSync(record.dir, { recursive: true });
    writeFileSync(String(child.sessionFile), "");

    const { view } = await harness.openView(record.id);
    const lines = plain(view.render(100));

    expect(lines[0]).toBe(`✓ ${record.id} (explorer) · done · ${record.model}`);
    expect(lines[4]).toBe("Effective prompt");
    expect(lines).toContain(" Three files: explorer.md, implementer.md, reviewer.md.");
    expect(lines.at(-1)).toMatch(/^Esc close · ctrl\+o tool detail · PgUp\/PgDn Home\/End wheel scroll/);
  });

  it("renders the transcript with pi's message and tool components", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const lines = plain(view.render(100));
    const transcript = lines.slice(lines.indexOf("Transcript"), -1);

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

  it("toggles sections with Enter and moves focus with Tab", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view, state } = await harness.openView(record.id);

    view.handleKey(key("tab"));
    view.handleKey(key("enter"));

    const lines = view.render(100);

    expect(lines).toContain("› ▾ System prompt · tools (4 lines)");
    expect(lines).toContain("    - read: Read file contents");

    view.handleKey(key("escape"));

    expect(state.closed).toBe(true);
  });

  it("opens at the tail, scrolls with keys and the wheel, and keeps the prompt block first", () => {
    const { view } = viewOf(readSessionFile(FIXTURE, RECORD_ENTRY), 20);
    const visible = () => plain(view.render(100)).slice(4, -1);

    expect(view.render(100)).toHaveLength(20);
    expect(visible()).not.toContain("Effective prompt");
    expect(plain(view.render(100)).at(-1)).toContain("following");

    view.handleKey(key("home"));

    expect(visible()[0]).toBe("Effective prompt");
    expect(visible()[1]).toBe("› ▸ System prompt · preamble (1 lines)");

    view.handleWheel?.(3);

    expect(visible()[0]).toBe("  ▸ System prompt · addendum (4 lines)");

    view.handleKey(key("pageDown"));
    view.handleKey(key("end"));

    expect(plain(view.render(100)).at(-1)).toContain("following");
  });

  it("follows new entries at the tail and keeps the position when scrolled up", () => {
    const { view, append, state } = viewOf(fixtureWithout(2), 20);
    const visible = () => plain(view.render(100)).slice(4, -1);

    visible();
    append(fixtureWithout(1));

    expect(state.renders).toBeGreaterThan(0);
    expect(visible().join("\n")).toContain("/repo/agents/explorer.md");

    view.handleKey(key("home"));

    const before = visible();

    append(readSessionFile(FIXTURE, RECORD_ENTRY));

    expect(visible()).toEqual(before);

    view.handleKey(key("end"));

    expect(visible()).toContain(" Three files: explorer.md, implementer.md, reviewer.md.");
  });

  it("starts a fresh transcript when the view follows a successor with another session file", () => {
    const { api } = fakeApi(40);
    const full = readSessionFile(FIXTURE, RECORD_ENTRY);
    const head = { ...full, items: full.items.slice(0, 2) };
    const tail = { ...full, items: full.items.slice(-2) };
    const harness = setup();
    const first = closedAgent(harness);
    let current = { record: first, session: head };
    let changed = () => {};

    const view = createAgentView(
      {
        ...viewDefaults,
        load: () => current,
        stop: () => undefined,
        send: async () => ({ ok: true, delivery: "steer" }),
        subscribe: (onChange) => {
          changed = onChange;
          return () => {};
        },
      },
      api,
    );

    const body = (lines: string[]) => plain(lines).slice(1).join("\n");
    const before = body(view.render(100));

    current = { record: { ...first, sessionFile: "/other.jsonl" }, session: tail };
    changed();

    const after = body(view.render(100));

    expect(after).not.toEqual(before);
    expect(after).toEqual(body(viewOf(tail, 40).view.render(100)));
  });

  it("enters grace on the first x and closes on the second, notifying the caller once", async () => {
    const harness = setup();
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute({ agents: [{ agent: "explorer", task: "long job" }] }, { update: () => {} });
    await flush();
    harness.host.settle();

    const record = harness.services.require("registry").list()[0];
    const { view } = await harness.openView(record.id);
    const lines = view.render(100);

    expect(lines[0]).toContain("running");
    expect(lines.at(-1)).toContain("x stop");

    view.handleKey(key("other", "x"));
    await flush();

    expect(harness.services.require("registry").get(record.id)?.state).toBe("grace");
    expect(view.render(100).at(-1)).toContain("x again closes now");

    view.handleKey(key("other", "x"));
    await flush();

    expect(harness.services.require("registry").get(record.id)?.state).toBe("stopped");
    expect(harness.runtime.child(record.id).aborted).toBe(true);
    expect(harness.host.sent).toHaveLength(1);
    expect(harness.host.sent[0]).toContain(`${record.id} (explorer) - stopped`);
  });

  it("only notifies for unknown agents and opens nothing", async () => {
    const harness = setup();

    await harness.host.runCommand("agents", "ghost-0000");

    expect(harness.host.overlays).toEqual([]);
    expect(harness.host.notices).toHaveLength(1);
    expect(harness.host.notices[0]?.message).toContain('unknown agent "ghost-0000"');
  });
});

const typeText = (view: { handleKey(key: KeyPress): void }, text: string) => {
  Array.from(text).forEach((char) => {
    view.handleKey(key("other", char));
  });
};

const tabToInput = (view: { handleKey(key: KeyPress): void }, sectionCount: number) => {
  Array.from({ length: sectionCount }).forEach(() => {
    view.handleKey(key("tab"));
  });
};

const runningAgent = async () => {
  const harness = setup();
  const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

  await runAgent.execute({ agents: [{ agent: "explorer", task: "long job" }] }, { update: () => {} });
  await flush();
  harness.host.settle();

  const record = harness.services.require("registry").list()[0];
  const opened = await harness.openView(record.id);

  return { harness, record, ...opened };
};

const openViewWith = (record: AgentRecord, send: (text: string) => Promise<RouteResult>) => {
  const { api, state } = fakeApi(60);
  const sent: string[] = [];

  const view = createAgentView(
    {
      ...viewDefaults,
      load: () => ({ record, session: readSessionFile(FIXTURE, RECORD_ENTRY) }),
      stop: () => undefined,
      send: (text) => {
        sent.push(text);
        return send(text);
      },
      subscribe: () => () => {},
    },
    api,
  );

  return { view, state, sent };
};

const SECTION_COUNT = 8;

describe("agent view message box", () => {
  it("reaches the input with Tab and routes the typed text as the user", async () => {
    const { harness, record, view } = await runningAgent();

    expect(plain(view.render(100)).at(-2)).toBe("  (type a message)");

    tabToInput(view, 1);

    expect(plain(view.render(100)).at(-2)).toBe("› (type a message)");
    expect(plain(view.render(100)).at(-1)).toMatch(/^Message box: Enter send/);

    typeText(view, "also check x tests");

    expect(harness.services.require("registry").get(record.id)?.state).toBe("running");
    expect(plain(view.render(100)).at(-2)).toBe("› also check x tests");

    view.handleKey(key("enter"));
    await flush();

    expect(harness.runtime.child(record.id).messages).toEqual([
      { message: { sender: "user", text: "also check x tests" }, delivery: "steer" },
    ]);

    const lines = plain(view.render(100));

    expect(lines).toContain("› (type a message)");
    expect(lines).toContain("sent: steered into the current run");
  });

  it("asks a stopped agent a question during grace", async () => {
    const { harness, record, view } = await runningAgent();

    view.handleKey(key("other", "x"));
    await flush();

    expect(harness.services.require("registry").get(record.id)?.state).toBe("grace");

    tabToInput(view, 1);
    typeText(view, "why?");
    view.handleKey(key("enter"));
    await flush();

    expect(harness.runtime.child(record.id).messages).toEqual([
      { message: { sender: "user", text: "why?" }, delivery: "followUp" },
    ]);
    expect(harness.services.require("registry").get(record.id)?.state).toBe("grace");
  });

  it("clears the text on Esc, leaves the box on a second Esc and closes on a third", async () => {
    const record = { ...closedAgent(setup()), state: "running" as const };
    const { view, state, sent } = openViewWith(record, async () => ({ ok: true, delivery: "steer" }));

    tabToInput(view, SECTION_COUNT);
    typeText(view, "draft");
    view.handleKey(key("escape"));

    expect(plain(view.render(100)).at(-2)).toBe("› (type a message)");
    expect(state.closed).toBe(false);

    view.handleKey(key("escape"));

    expect(plain(view.render(100)).at(-2)).toBe("  (type a message)");
    expect(state.closed).toBe(false);

    view.handleKey(key("escape"));

    expect(state.closed).toBe(true);
    expect(sent).toEqual([]);
  });

  it("cycles from the input back to the first prompt section with Tab", () => {
    const record = { ...closedAgent(setup()), state: "running" as const };
    const { view } = openViewWith(record, async () => ({ ok: true, delivery: "steer" }));

    tabToInput(view, SECTION_COUNT);
    view.handleKey(key("tab"));
    view.handleKey(key("home"));

    const lines = plain(view.render(100));

    expect(lines).toContain("› ▸ System prompt · preamble (1 lines)");
    expect(lines.at(-2)).toBe("  (type a message)");
  });

  it("types x into the focused box instead of stopping", async () => {
    const { harness, record, view } = await runningAgent();

    tabToInput(view, 1);
    view.handleKey(key("other", "x"));
    await flush();

    expect(harness.services.require("registry").get(record.id)?.state).toBe("running");
    expect(plain(view.render(100)).at(-2)).toBe("› x");
  });

  it("shows a failed route under the input until the next key and keeps the text", async () => {
    const record = { ...closedAgent(setup()), state: "running" as const };
    const { view, sent } = openViewWith(record, async () => ({ ok: false, error: "agent is closed" }));

    tabToInput(view, SECTION_COUNT);
    typeText(view, "hello");
    view.handleKey(key("enter"));
    await flush();

    const lines = plain(view.render(100));

    expect(sent).toEqual(["hello"]);
    expect(lines.at(-3)).toBe("› hello");
    expect(lines.at(-2)).toBe("agent is closed");

    view.handleKey(key("other", "!"));

    expect(plain(view.render(100)).at(-2)).toBe("› hello!");
  });

  it("shows no input box for a closed agent and says it is closed", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);

    tabToInput(view, SECTION_COUNT + 1);

    const lines = plain(view.render(100));

    expect(lines.join("\n")).not.toContain("(type a message)");
    expect(lines.at(-1)).toContain("agent closed, messages disabled");
  });
});

describe("agent view input focus", () => {
  it("focuses the message box only while it has focus", () => {
    const record = { ...closedAgent(setup()), state: "running" as const };
    const { api } = fakeApi(60);
    const panes: ReturnType<typeof createFakeInputPane>[] = [];

    const createInput = () => {
      const pane = createFakeInputPane();

      panes.push(pane);

      return pane;
    };

    const view = createAgentView(
      {
        ...viewDefaults,
        load: () => ({ record, session: readSessionFile(FIXTURE, RECORD_ENTRY) }),
        stop: () => undefined,
        send: async () => ({ ok: true, delivery: "steer" }),
        subscribe: () => () => {},
      },
      { ...api, createInput },
    );

    view.render(100);

    expect(panes.map((pane) => pane.isFocused())).toEqual([false]);

    tabToInput(view, SECTION_COUNT);

    expect(panes[0]?.isFocused()).toBe(true);

    view.handleKey(key("tab"));

    expect(panes[0]?.isFocused()).toBe(false);

    tabToInput(view, SECTION_COUNT);
    view.handleKey(key("escape"));

    expect(panes[0]?.isFocused()).toBe(false);
  });
});

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

const waitForRefresh = () => new Promise<void>((done) => setTimeout(done, 350));

describe("agent view successor chain", () => {
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

    const factory = harness.host.overlays.at(-1);

    if (!factory) {
      throw new Error("no overlay opened");
    }

    const view = factory(fakeApi(200).api);

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
    expect(lines[0]).toContain(`${second} #2`);
    expect(lines[0]).toContain(`continues ${first.id}`);
    expect(lines).toContain("  (type a message)");
    expect(lines.at(-1)).toContain(`opened ${first.id}, following the chain`);
    expect(lines.at(-1)).toContain("x stop");

    view.handleKey(key("other", "x"));
    await flush();

    expect(registry.get(second)?.state).toBe("stopped");
  });
});

describe("agent view header", () => {
  it("shows the chain index, chain links and a pending question", () => {
    const base = closedAgent(setup());
    const record: AgentRecord = {
      ...base,
      state: "running",
      chainIndex: 2,
      predecessorId: "explorer-0001",
      successorId: "explorer-0003",
      attention: { kind: "confirm", title: "Allow rm -rf build?", since: 0 },
    };

    const { view } = openViewWith(record, async () => ({ ok: true, delivery: "steer" }));

    expect(plain(view.render(200))[0]).toBe(
      `⠋ ${record.id} #2 (explorer) · running · model n/a · continues explorer-0001 · continued by explorer-0003 · needs input: Allow rm -rf build?`,
    );
  });
});

describe("agent view context breakdown", () => {
  it("toggles the block under the header with c and names the key in the hint bar", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const hidden = plain(view.render(100));

    expect(hidden[4]).toBe("Effective prompt");
    expect(hidden.at(-1)).toContain("wheel scroll · c context breakdown · Tab/Enter prompt sections");

    view.handleKey(key("other", "c"));

    const shown = plain(view.render(100));

    expect(shown[4]).toBe("Context · ~ marks estimates (characters / 4), used is measured · c hides");
    expect(shown.slice(5, 14).map((line) => line.trim().split(/ {2,}/)[0])).toEqual([
      "system prompt",
      "tools",
      "skills",
      "messages",
      "user",
      "assistant",
      "tool results",
      "used",
      "free space",
    ]);
    expect(shown[15]).toMatch(/^─+$/);
    expect(shown[16]).toBe("Effective prompt");
    expect(shown.at(-1)).toContain("c hide context");

    view.handleKey(key("other", "c"));

    expect(plain(view.render(100))).toEqual(hidden);
  });

  it("reads the measured total of a closed agent from its session file", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);

    view.handleKey(key("other", "c"));

    const lines = plain(view.render(100));
    const row = (label: string) => lines.find((line) => line.startsWith(`  ${label} `)) ?? "";

    expect(row("used")).toMatch(/^ {2}used +2\.3k +2\.3% +░+$/);
    expect(row("free space")).toMatch(/^ {2}free space +97\.7k +97\.7% +█+░?$/);
    expect(row("system prompt")).toMatch(/^ {2}system prompt +\d+~ /);
    expect(row("tools")).toMatch(/^ {2}tools +\d+~ /);
    expect(lines).toContain("  limit 100.0k tokens (model window unknown)");
  });

  const openFromManifest = async (manifest: Record<string, unknown>) => {
    const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin]);
    const id = String(manifest.id);
    const dir = join(agentsDirFor(harness.host.info), id);
    const file = join(dir, "session.jsonl");

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ description: "old", state: "done", sessionFile: file, ...manifest }),
    );
    harness.runtime.sessions.set(file, readSessionFile(FIXTURE, RECORD_ENTRY));

    await harness.host.runCommand("agents", id);

    const view = harness.host.overlays.at(-1)?.(fakeApi(200).api);

    view?.handleKey(key("other", "c"));

    return plain(view?.render(100) ?? []);
  };

  it("opens from the manifest with the definition's limit", async () => {
    const lines = await openFromManifest({ id: "explorer-dead", agent: "explorer" });

    expect(lines).toContain("  limit 100.0k tokens (model window unknown)");
    expect(lines.find((line) => line.startsWith("  used "))).toMatch(/2\.3k /);
  });

  it("prefers the limit stored in the manifest and says so when no limit is known", async () => {
    const stored = await openFromManifest({ id: "explorer-old", agent: "explorer", contextLimit: 70_000 });
    const gone = await openFromManifest({ id: "removed-old", agent: "removed" });

    expect(stored).toContain("  limit 70.0k tokens (model window unknown)");
    expect(gone).toContain("  limit unknown (the agent's file is gone)");
    expect(gone.find((line) => line.startsWith("  used "))).toMatch(/2\.3k +0\.0%/);
  });

  it("refreshes the block with the live turn context", async () => {
    const { harness, record, view } = await runningAgent();

    view.handleKey(key("other", "c"));
    harness.runtime.child(record.id).turn({ tokens: 85_000, window: 200_000, percent: 42 });
    await flush();
    await waitForRefresh();

    const lines = plain(view.render(100));

    expect(lines.find((line) => line.startsWith("  used "))).toMatch(/^ {2}used +85\.0k +85\.0% +█{17}░{3}$/);
    expect(lines).toContain("  limit 100.0k tokens (50% of the model window 200.0k)");
  });
});

describe("agent view modes", () => {
  const stateFile = (harness: ReturnType<typeof setup>) =>
    join(harness.host.info.agentDir, "pi-subagents-view.json");

  const storedMode = (harness: ReturnType<typeof setup>) =>
    JSON.parse(readFileSync(stateFile(harness), "utf8")).mode;

  it("opens in focus and switches to verbose with v, expanding sections, tool detail and context", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);
    const focus = plain(view.render(100));

    expect(focus[4]).toBe("Effective prompt");
    expect(focus).toContain("  ▸ System prompt · tools (4 lines)");
    expect(focus).not.toContain(" - One finding per line.");
    expect(focus.at(-1)).toContain("Tab/Enter prompt sections · focus view, v verbose");

    view.handleKey(key("other", "v"));

    const verbose = plain(view.render(100));

    expect(verbose[4]).toBe("Context · ~ marks estimates (characters / 4), used is measured · c hides");
    expect(verbose).toContain("  ▾ System prompt · tools (4 lines)");
    expect(verbose).toContain("    - read: Read file contents");
    expect(verbose).toContain(" - One finding per line.");
    expect(verbose.at(-1)).toContain("verbose view, v focus");
    expect(storedMode(harness)).toBe("verbose");

    view.handleKey(key("other", "v"));

    expect(plain(view.render(100))).toEqual(focus);
    expect(storedMode(harness)).toBe("focus");
  });

  it("lets c, the tools key and section toggles change the view without changing the stored mode", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const { view } = await harness.openView(record.id);

    view.handleKey(key("other", "v"));
    view.handleKey(key("other", "c"));
    view.handleKey(key("toggleTools"));
    view.handleKey(key("enter"));

    const lines = plain(view.render(100));

    expect(lines[4]).toBe("Effective prompt");
    expect(lines).not.toContain(" - One finding per line.");
    expect(lines).toContain("› ▸ System prompt · preamble (1 lines)");
    expect(lines).toContain("  ▾ System prompt · tools (4 lines)");
    expect(lines.at(-1)).toContain("verbose view, v focus");
    expect(storedMode(harness)).toBe("verbose");
  });

  it("restores the stored mode in the next view and in a fresh session with the same agent dir", async () => {
    const first = setup();
    const record = closedAgent(first);
    const opened = await first.openView(record.id);

    opened.view.handleKey(key("other", "v"));

    const reopened = await first.openView(record.id);

    expect(plain(reopened.view.render(100)).at(-1)).toContain("verbose view, v focus");

    const fresh = setup();

    fresh.host.info.agentDir = first.host.info.agentDir;

    const other = closedAgent(fresh);
    const { view } = await fresh.openView(other.id);
    const lines = plain(view.render(100));

    expect(lines.at(-1)).toContain("verbose view, v focus");
    expect(lines).toContain(" - One finding per line.");
  });

  it("treats a missing or corrupt state file as focus", async () => {
    const harness = setup();
    const record = closedAgent(harness);

    mkdirSync(harness.host.info.agentDir, { recursive: true });
    writeFileSync(stateFile(harness), "{ not json");

    const { view } = await harness.openView(record.id);

    expect(plain(view.render(100)).at(-1)).toContain("focus view, v verbose");

    writeFileSync(stateFile(harness), JSON.stringify({ mode: "loud" }));

    const again = await harness.openView(record.id);

    expect(plain(again.view.render(100)).at(-1)).toContain("focus view, v verbose");
  });
});

describe("agent view worktree", () => {
  it("shows the worktree and branch under the task", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const worktree = {
      path: "/agents/explorer-1/worktree",
      branch: "pi-agents/explorer-1",
      cwd: "/agents/x",
    };

    harness.services.require("registry").update(record.id, { worktree });

    const { view } = await harness.openView(record.id);
    const lines = plain(view.render(100));

    expect(lines[2]).toBe("worktree: /agents/explorer-1/worktree (branch pi-agents/explorer-1)");
    expect(lines[5]).toBe("Effective prompt");
  });
});

describe("agent view refresh", () => {
  it("does not parse the session file again while its size and time are unchanged", async () => {
    const harness = setup();
    const record = closedAgent(harness);
    const readSession = vi.spyOn(harness.runtime, "readSession");
    const registry = harness.services.require("registry");
    const { view } = await harness.openView(record.id);

    view.render(100);
    registry.update(record.id, { tokens: 1 });
    await waitForRefresh();
    registry.update(record.id, { tokens: 2 });
    await waitForRefresh();
    view.render(100);

    expect(readSession).toHaveBeenCalledTimes(1);

    writeFileSync(String(record.sessionFile), "{}\n");
    registry.update(record.id, { tokens: 3 });
    await waitForRefresh();

    expect(readSession).toHaveBeenCalledTimes(2);

    view.dispose?.();
  });

  it("never reloads after close, and reports a failed stop", async () => {
    const harness = setup();
    const record = { ...closedAgent(harness), state: "running" as const };
    const { api, state } = fakeApi(60);
    let loads = 0;
    let finishStop: () => void = () => {};

    const stops = [
      () => Promise.reject(new Error("runner gone")),
      () =>
        new Promise<void>((done) => {
          finishStop = done;
        }),
    ];

    const view = createAgentView(
      {
        ...viewDefaults,
        load: () => {
          loads += 1;
          return { record, session: readSessionFile(FIXTURE, RECORD_ENTRY) };
        },
        stop: () => stops.shift()?.(),
        send: async () => ({ ok: true, delivery: "steer" }),
        subscribe: () => () => {},
      },
      api,
    );

    view.handleKey(key("other", "x"));
    await flush();

    expect(plain(view.render(100))).toContain("stop failed: runner gone");

    view.handleKey(key("other", "x"));
    view.handleKey(key("escape"));
    finishStop();
    await flush();

    expect(state.closed).toBe(true);
    expect(loads).toBe(1);
  });
});

describe("agent view past sessions", () => {
  const writeManifest = (harness: ReturnType<typeof setup>, manifest: Record<string, unknown>) => {
    const dir = join(agentsDirFor(harness.host.info), String(manifest.id));

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, MANIFEST_FILE),
      typeof manifest.raw === "string" ? manifest.raw : JSON.stringify(manifest),
    );

    return dir;
  };

  it("follows a chain of an earlier session to its last link", async () => {
    const harness = setup();
    const file = join(harness.root, "old-2.jsonl");

    writeFileSync(file, "");
    harness.runtime.sessions.set(file, readSessionFile(FIXTURE, RECORD_ENTRY));
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

    expect(lines[0]).toContain("explorer-old2 #2");
    expect(lines.at(-1)).toContain("opened explorer-old1, following the chain");
  });

  it("reports a corrupt manifest instead of throwing", async () => {
    const harness = setup();

    writeManifest(harness, { id: "explorer-bad", raw: "{ broken" });
    await harness.host.runCommand("agents", "explorer-bad");

    expect(harness.host.overlays).toEqual([]);
    expect(harness.host.notices.at(-1)?.message).toContain('cannot read manifest of "explorer-bad"');
  });
});
