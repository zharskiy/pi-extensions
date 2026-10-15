import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewComponent } from "../../../../../core/adapter/contract.ts";
import { initRenderTheme } from "../../../../../core/test/adapter/render-theme.ts";
import { agentsDirFor, MANIFEST_FILE } from "../../../src/model/paths.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentPanelPlugin } from "../../../src/plugins/agent-panel/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { createHarness } from "../../helpers/harness.ts";
import {
  disposeOverlays,
  fakeOverlayApi,
  grepSession,
  key,
  openLastOverlay,
  selectedRow,
} from "../../helpers/overlay.ts";
import { newAgentInput } from "../../helpers/records.ts";

initRenderTheme();

afterEach(() => {
  disposeOverlays();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin]);
  const registry = harness.services.require("registry");

  const create = (description: string, createdAt: number) => {
    const record = registry.create(newAgentInput(harness.root, { description }));

    registry.update(record.id, { state: "running", createdAt });

    return record;
  };

  const openLast = () => {
    const { view, state, lines } = openLastOverlay(harness.host, 40);

    return { overlay: view, state, lines };
  };

  return { ...harness, registry, create, openLast };
};

describe("agents overlay", () => {
  it("Enter swaps to the view in the same overlay and Esc returns to the list with the selection kept", async () => {
    const harness = setup();

    harness.create("first job", 1);

    const second = harness.create("second job", 2);

    await harness.host.runCommand("agents", "");

    const { overlay, state, lines } = harness.openLast();

    overlay.handleKey(key("down"));
    overlay.handleKey(key("enter"));

    expect(lines()[1]).toMatch(/^ \S explorer › second job$/);
    expect(lines()[2]?.endsWith(`id ${second.id}`)).toBe(true);
    expect(lines().at(-2)?.startsWith(" esc to go back")).toBe(true);
    expect(state.closed).toBe(false);
    expect(harness.host.overlays).toHaveLength(1);

    overlay.handleKey(key("escape"));

    expect(selectedRow(lines())).toContain("second job");
    expect(state.closed).toBe(false);

    overlay.handleKey(key("escape"));

    expect(state.closed).toBe(true);
  });

  it("left on an empty editor opens the agents list", () => {
    const harness = setup();

    harness.create("first job", 1);

    expect(harness.host.pressEmptyLeft()).toBe(true);
    expect(harness.host.overlays).toHaveLength(1);

    const { lines } = harness.openLast();

    expect(selectedRow(lines())).toContain("first job");
  });

  it("left on a selected panel row clears the selection and opens the list", () => {
    const harness = createHarness([
      agentRegistryPlugin,
      agentDefinitionsPlugin,
      agentPanelPlugin,
      agentViewPlugin,
    ]);

    harness.services.require("registry").create(newAgentInput(harness.root));

    expect(harness.host.pressEmptyDown()).toBe(true);
    expect(harness.host.editorCapture).toBeDefined();
    expect(harness.host.pressEditorKey({ name: "left" })).toBe("release");
    expect(harness.host.editorCapture).toBeUndefined();
    expect(harness.host.overlays).toHaveLength(1);
  });

  it("left on an empty editor with no agents opens the list", () => {
    const harness = setup();

    expect(harness.host.pressEmptyLeft()).toBe(true);
    expect(harness.host.overlays).toHaveLength(1);

    const { lines } = harness.openLast();

    expect(lines().join("\n")).toContain("No agents running");
  });

  it("drops the left hook on disable", async () => {
    const harness = setup();

    harness.create("first job", 1);
    await harness.manager.disableAll();

    expect(harness.host.emptyLeftHandlers.size).toBe(0);
  });

  it("reloads the list on return", async () => {
    const harness = setup();
    const record = harness.create("closing job", 1);

    await harness.host.runCommand("agents", "");

    const { overlay, lines } = harness.openLast();

    overlay.handleKey(key("enter"));
    harness.registry.close(record.id, { state: "done" });
    overlay.handleKey(key("escape"));

    expect(lines()).toContain(" Completed (1)");
    expect(lines().join("\n")).toContain("closing job");
  });

  it("forwards clicks to the current part", async () => {
    const harness = setup();
    const record = harness.create("grep job", 1);
    const file = join(harness.root, "grep.jsonl");

    writeFileSync(file, "");
    harness.runtime.sessions.set(file, grepSession());
    harness.registry.close(record.id, { state: "done", sessionFile: file });
    await harness.host.runCommand("agents", "");

    const { overlay, lines } = harness.openLast();

    expect(overlay.handleClick?.(5, 3)).toBe(false);

    overlay.handleKey(key("enter"));

    const before = lines();

    expect(
      overlay.handleClick?.(
        5,
        before.findIndex((line) => line.includes("alpha 10")),
      ),
    ).toBe(true);
    expect(lines().at(-2)).toMatch(/\/71$/);
  });

  it("/agents <id> opens the view and Esc closes the overlay", async () => {
    const harness = setup();
    const record = harness.create("job", 1);

    await harness.host.runCommand("agents", record.id);

    const { overlay, state, lines } = harness.openLast();

    expect(lines().at(-2)?.startsWith(" esc to close")).toBe(true);

    overlay.handleKey(key("escape"));

    expect(state.closed).toBe(true);
  });

  it("a view opened from the panel closes on Esc", async () => {
    const harness = setup();
    const record = harness.create("job", 1);

    await harness.services.require("agentView").open(record.id);

    const { overlay, state, lines } = harness.openLast();

    expect(lines().at(-2)?.startsWith(" esc to close")).toBe(true);

    overlay.handleKey(key("escape"));

    expect(state.closed).toBe(true);
  });

  it("only notifies for unknown agents and opens nothing", async () => {
    const harness = setup();

    await harness.host.runCommand("agents", "ghost-0000");

    expect(harness.host.overlays).toEqual([]);
    expect(harness.host.notices).toHaveLength(1);
    expect(harness.host.notices[0]?.message).toContain('unknown agent "ghost-0000"');
  });

  it("reports a corrupt manifest instead of throwing", async () => {
    const harness = setup();
    const dir = join(agentsDirFor(harness.host.info), "explorer-bad");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_FILE), "{ broken");
    await harness.host.runCommand("agents", "explorer-bad");

    expect(harness.host.overlays).toEqual([]);
    expect(harness.host.notices.at(-1)?.message).toContain('cannot read manifest of "explorer-bad"');
  });

  it("closes and disposes an open overlay when the session shuts down", async () => {
    vi.useFakeTimers();

    const harness = setup();
    const subscriptions = new Set<() => void>();
    const on = harness.bus.on;

    vi.spyOn(harness.bus, "on").mockImplementation(((event, listener) => {
      const off = on(event, listener);
      const tracked = () => {
        subscriptions.delete(tracked);
        off();
      };

      subscriptions.add(tracked);

      return tracked;
    }) as typeof on);

    harness.create("job", 1);

    const { api, state } = fakeOverlayApi(40);
    let overlay: ViewComponent | undefined;

    harness.host.ui.openOverlay = (factory) =>
      new Promise<void>((resolve) => {
        overlay = factory({
          ...api,
          close: () => {
            api.close();
            resolve();
          },
        });
      });

    let settled = false;
    const opened = harness.host.runCommand("agents", "").then(() => {
      settled = true;
    });

    overlay?.render(100);
    overlay?.handleKey(key("enter"));
    overlay?.render(100);

    expect(subscriptions.size).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    harness.host.onSessionShutdown(() => harness.manager.disableAll());
    await harness.host.shutdown();

    expect(state.closed).toBe(true);
    expect(subscriptions.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await opened;

    expect(settled).toBe(true);
  });

  it("disposes the hidden list and the view when the overlay closes", async () => {
    vi.useFakeTimers();

    const harness = setup();
    const record = harness.create("job", 1);

    await harness.host.runCommand("agents", "");

    const factory = harness.host.overlays.at(-1);
    const { api, state } = fakeOverlayApi(40);
    const overlay = factory?.(api);

    overlay?.render(100);
    overlay?.handleKey(key("enter"));
    overlay?.render(100);
    overlay?.handleKey(key("escape"));
    overlay?.handleKey(key("escape"));

    expect(state.closed).toBe(true);

    overlay?.dispose?.();

    const renders = state.renders;

    harness.registry.update(record.id, { tokens: 5 });
    vi.advanceTimersByTime(1_000);

    expect(state.renders).toBe(renders);
  });

  it("forgets an overlay pi disposed, so disable does not close it again", async () => {
    const harness = setup();

    harness.create("job", 1);
    await harness.host.runCommand("agents", "");

    const { overlay, state } = harness.openLast();

    overlay.dispose?.();
    await harness.manager.disableAll();

    expect(state.closed).toBe(false);
  });
});
