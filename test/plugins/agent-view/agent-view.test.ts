import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { KeyPress, OverlayApi, SessionRecord } from "../../../src/adapter/contract.ts";
import { createScrollPane, createTranscriptPane, initRenderTheme } from "../../../src/adapter/pi-adapter.ts";
import { readSessionFile } from "../../../src/adapter/session-file.ts";
import { renderSections, setAllCollapsed } from "../../../src/components/collapsible.ts";
import { promptSections } from "../../../src/components/system-prompt-block.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentViewPlugin, COMMAND } from "../../../src/plugins/agent-view/index.ts";
import { createAgentView } from "../../../src/plugins/agent-view/view.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { flush, plainTheme } from "../../helpers/fakes.ts";
import { createHarness } from "../../helpers/harness.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "recorded-session.jsonl");

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
    toolsExpanded: false,
    toolsKey: "ctrl+o",
    wheelScrolling: true,
    createTranscript: () => createTranscriptPane({ requestRender } as never, "/repo", false),
    createScroll: () => createScrollPane(requestRender),
  };

  return { api, state };
};

const key = (name: KeyPress["name"], char?: string): KeyPress => ({ name, char });

describe("system prompt block", () => {
  it("renders the recorded prompt, tools, skills, guidelines and provider payload", () => {
    const session = readSessionFile(FIXTURE);
    const sections = setAllCollapsed(promptSections(session.prompt), false);
    const rendered = renderSections(sections, 0, plainTheme, (text) => [text]);

    expect(rendered.lines.join("\n")).toMatchSnapshot();
    expect(session.prompt.model).toBe("openai/gpt-6-luna");
  });

  it("starts collapsed with one header per section", () => {
    const session = readSessionFile(FIXTURE);
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
    await harness.host.commands.get(COMMAND)?.run(args);

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
  harness.runtime.sessions.set(file, readSessionFile(FIXTURE));

  const registry = harness.services.require("registry");

  const record = registry.create({
    agent: "explorer",
    task: "t",
    description: "t",
    callerId: "main",
    depth: 2,
    batchId: "b-x",
    dir: join(harness.root, "agents"),
    budgetTokens: 100_000,
  });

  registry.close(record.id, { state: "done", sessionFile: file });

  return record;
};

const viewOf = (session: SessionRecord, rows: number) => {
  const { api, state } = fakeApi(rows);
  let current = session;
  let changed = () => {};

  const harness = setup();
  const record = closedAgent(harness);

  const view = createAgentView(
    {
      load: () => ({ record, session: current }),
      stop: () => undefined,
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
  const session = readSessionFile(FIXTURE);

  return { ...session, items: session.items.slice(0, session.items.length - count) };
};

describe("agent view", () => {
  it("reuses the rendered prompt block until sections, focus or width change", () => {
    const { api } = fakeApi(40);
    const harness = setup();
    const record = closedAgent(harness);
    const session = readSessionFile(FIXTURE);
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
      { load: () => ({ record, session }), stop: () => undefined, subscribe: () => () => {} },
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

    harness.runtime.sessions.set(String(child.sessionFile), readSessionFile(FIXTURE));
    mkdirSync(record.dir, { recursive: true });
    writeFileSync(String(child.sessionFile), "");

    const { view } = await harness.openView(record.id);
    const lines = plain(view.render(100));

    expect(lines[0]).toBe(`✓ ${record.id} (explorer) · done · openai/gpt-6-luna:low`);
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
    const { view } = viewOf(readSessionFile(FIXTURE), 20);
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

    append(readSessionFile(FIXTURE));

    expect(visible()).toEqual(before);

    view.handleKey(key("end"));

    expect(visible()).toContain(" Three files: explorer.md, implementer.md, reviewer.md.");
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

    await harness.host.commands.get(COMMAND)?.run("ghost-0000");

    expect(harness.host.overlays).toEqual([]);
    expect(harness.host.notices).toHaveLength(1);
    expect(harness.host.notices[0]?.message).toContain('unknown agent "ghost-0000"');
  });
});
