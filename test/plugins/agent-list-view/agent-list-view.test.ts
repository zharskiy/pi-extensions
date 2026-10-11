import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyPress, OverlayApi, ViewComponent } from "../../../src/adapter/contract.ts";
import { createScrollPane, initRenderTheme } from "../../../src/adapter/pi-adapter.ts";
import type { NewAgent } from "../../../src/manager/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentListViewPlugin } from "../../../src/plugins/agent-list-view/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentViewPlugin, COMMAND } from "../../../src/plugins/agent-view/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createFakeInputPane, flush, plainTheme } from "../../helpers/fakes.ts";
import { createHarness } from "../../helpers/harness.ts";

initRenderTheme();

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

const key = (name: KeyPress["name"], char?: string): KeyPress => ({ name, char });

const views: ViewComponent[] = [];

afterEach(() => {
  views.splice(0).forEach((view) => {
    view.dispose?.();
  });
});

const fakeApi = (rows: number) => {
  const state = { closed: false };

  const api: OverlayApi = {
    theme: plainTheme,
    rows: () => rows,
    close: () => {
      state.closed = true;
    },
    requestRender: () => {},
    toolsExpanded: false,
    toolsKey: "ctrl+o",
    wheelScrolling: true,
    createTranscript: () => ({ sync: () => {}, setToolsExpanded: () => {}, render: () => [] }),
    createScroll: () => createScrollPane(() => {}),
    createInput: createFakeInputPane,
  };

  return { api, state };
};

const newAgent = (root: string, patch: Partial<NewAgent> = {}): NewAgent => ({
  agent: "explorer",
  task: "t",
  description: "look around",
  callerId: "main",
  depth: 2,
  batchId: "b-1",
  dir: root,
  budgetTokens: 100_000,
  ...patch,
});

const setup = () => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    runAgentPlugin,
    agentViewPlugin,
    agentListViewPlugin,
  ]);

  const registry = harness.services.require("registry");

  const openList = async (rows = 40) => {
    await harness.host.runCommand(COMMAND, "");
    await flush();

    const factory = harness.host.overlays.at(-1);

    if (!factory) {
      throw new Error("no overlay opened");
    }

    const { api, state } = fakeApi(rows);
    const view = factory(api);

    views.push(view);

    return { view, state, lines: () => plain(view.render(100)) };
  };

  const spawn = async (count: number) => {
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");
    const agents = Array.from({ length: count }, (_, index) => ({ agent: "explorer", task: `job ${index}` }));

    await runAgent.execute({ agents }, { update: () => {} });
    await flush();
    harness.host.settle();

    return registry.list();
  };

  return { ...harness, registry, openList, spawn };
};

const typeText = (view: ViewComponent, text: string) => {
  Array.from(text).forEach((char) => {
    view.handleKey(key("other", char));
  });
};

describe("agent list view", () => {
  it("opens from /agents without an id and shows the empty state", async () => {
    const harness = setup();
    const { lines } = await harness.openList();

    expect(harness.host.dispatched).toEqual([]);
    expect(lines()[0]).toBe("Agents · 0 open · 0 total");
    expect(lines()).toContain("no agents in this session yet");
  });

  it("groups agents by state, newest first", async () => {
    const harness = setup();
    const create = (patch: Partial<NewAgent>, createdAt: number) => {
      const record = harness.registry.create(newAgent(harness.root, patch));

      harness.registry.update(record.id, { createdAt, state: "running" });

      return record;
    };

    const first = create({ description: "first" }, 1);
    const second = create({ description: "second" }, 2);
    const asking = create({ description: "asking" }, 3);
    const done = create({ description: "done" }, 4);

    harness.registry.update(asking.id, { attention: { kind: "confirm", title: "Allow bash?", since: 3 } });
    harness.registry.close(done.id, { state: "done" });

    const { lines } = await harness.openList();
    const body = lines().slice(2, 12);

    expect(body[0]).toBe("Working · 2");
    expect(body[1]).toMatch(new RegExp(`^› . ${second.id} · second`));
    expect(body[2]).toMatch(new RegExp(`^  . ${first.id} · first`));
    expect(body[4]).toBe("Needs attention · 1");
    expect(body[5]).toContain(`${asking.id} · asking`);
    expect(body[5]).toContain("needs input: Allow bash?");
    expect(body[7]).toBe("Done · 1");
    expect(body[8]).toContain(`${done.id} · done`);
  });

  it("moves the cursor over headers and opens the selected agent with Enter", async () => {
    const harness = setup();
    const agents = harness.registry;
    const older = agents.create(newAgent(harness.root, { description: "older" }));
    const closed = agents.create(newAgent(harness.root, { description: "closed one" }));

    agents.update(older.id, { createdAt: 1 });
    agents.close(closed.id, { state: "done" });

    const { view, state, lines } = await harness.openList();

    expect(lines().find((line) => line.startsWith("›"))).toContain(older.id);

    view.handleKey(key("down"));

    expect(lines().find((line) => line.startsWith("›"))).toContain(closed.id);

    view.handleKey(key("down"));
    view.handleKey(key("up"));
    view.handleKey(key("up"));

    expect(lines().find((line) => line.startsWith("›"))).toContain(older.id);

    view.handleKey(key("down"));
    view.handleKey(key("enter"));
    await flush();

    expect(state.closed).toBe(true);
    expect(harness.host.overlays).toHaveLength(2);
    expect(plain(harness.host.overlays[1](fakeApi(40).api).render(100))[0]).toContain(closed.id);
  });

  it("stops the selected agent with x and closes it with a second x", async () => {
    const harness = setup();
    const [record] = await harness.spawn(1);
    const { view, lines } = await harness.openList();

    expect(lines().at(-1)).toContain("x stop");

    view.handleKey(key("other", "x"));
    await flush();

    expect(harness.registry.get(record.id)?.state).toBe("grace");
    expect(harness.runtime.child(record.id).aborted).toBe(true);
    expect(lines()).toContain("Needs attention · 1");
    expect(lines().at(-1)).toContain("x again closes now");

    view.handleKey(key("other", "x"));
    await flush();

    expect(harness.registry.get(record.id)?.state).toBe("stopped");
  });

  it("stops every open agent after X and y", async () => {
    const harness = setup();
    const records = await harness.spawn(3);
    const { view, lines } = await harness.openList();

    view.handleKey(key("other", "X"));

    expect(lines().at(-1)).toBe("Stop all 3 open agents? y confirms · any other key cancels");

    view.handleKey(key("other", "y"));
    await flush();

    expect(records.map((record) => harness.registry.get(record.id)?.state)).toEqual([
      "grace",
      "grace",
      "grace",
    ]);
  });

  it("stops nothing after X and any other key", async () => {
    const harness = setup();
    const records = await harness.spawn(2);
    const { view, state, lines } = await harness.openList();

    view.handleKey(key("other", "X"));
    view.handleKey(key("other", "n"));
    await flush();

    expect(records.map((record) => harness.registry.get(record.id)?.state)).toEqual(["running", "running"]);
    expect(lines().at(-1)).toContain("X stop all");

    view.handleKey(key("other", "X"));
    view.handleKey(key("escape"));

    expect(state.closed).toBe(false);
    expect(records.map((record) => harness.registry.get(record.id)?.state)).toEqual(["running", "running"]);
  });

  it("filters rows with / and clears the filter with Esc", async () => {
    const harness = setup();
    const explorer = harness.registry.create(newAgent(harness.root));
    const reviewer = harness.registry.create(newAgent(harness.root, { agent: "reviewer" }));
    const { view, state, lines } = await harness.openList();

    view.handleKey(key("other", "/"));
    typeText(view, "review");

    expect(lines().join("\n")).toContain(reviewer.id);
    expect(lines().join("\n")).not.toContain(explorer.id);
    expect(lines()).toContain("/ review");

    view.handleKey(key("enter"));

    expect(lines()).toContain("filter: review");
    expect(lines().at(-1)).toContain("Esc clear filter");

    view.handleKey(key("escape"));

    expect(state.closed).toBe(false);
    expect(lines().join("\n")).toContain(explorer.id);

    view.handleKey(key("other", "/"));
    typeText(view, "zzz");

    expect(lines()).toContain('no agents match "zzz"');

    view.handleKey(key("escape"));

    expect(lines().join("\n")).toContain(explorer.id);

    view.handleKey(key("escape"));

    expect(state.closed).toBe(true);
  });

  it("keeps the selected row visible while moving through a long list", async () => {
    const harness = setup();

    Array.from({ length: 30 }).forEach((_, index) => {
      const record = harness.registry.create(newAgent(harness.root, { description: `job ${index}` }));

      harness.registry.update(record.id, { createdAt: 100 - index });
    });

    const { view, lines } = await harness.openList(12);

    expect(lines()[2]).toBe("Working · 30");

    Array.from({ length: 20 }).forEach(() => {
      view.handleKey(key("down"));
    });

    expect(lines().find((line) => line.startsWith("›"))).toContain("job 20");

    view.handleKey(key("home"));

    expect(lines()[2]).toBe("Working · 30");
  });
});
