import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewComponent } from "../../../../../core/adapter/contract.ts";
import { initRenderTheme } from "../../../../../core/test/adapter/render-theme.ts";
import { agentsDirFor, MANIFEST_FILE } from "../../../src/model/paths.ts";
import type { AgentRecord, NewAgent } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { createHarness } from "../../helpers/harness.ts";
import { fakeOverlayApi, key, plain } from "../../helpers/overlay.ts";

initRenderTheme();

const views: ViewComponent[] = [];

afterEach(() => {
  views.splice(0).forEach((view) => {
    view.dispose?.();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, agentViewPlugin]);
  const registry = harness.services.require("registry");

  const create = (description: string, createdAt: number) => {
    const input: NewAgent = {
      agent: "explorer",
      description,
      callerId: "main",
      depth: 2,
      batchId: "b-1",
      dir: harness.root,
      contextLimit: 100_000,
    };
    const record = registry.create(input);

    registry.update(record.id, { state: "running", createdAt });

    return record;
  };

  const openLast = () => {
    const factory = harness.host.overlays.at(-1);

    if (!factory) {
      throw new Error("no overlay opened");
    }

    const { api, state } = fakeOverlayApi(40);
    const overlay = factory(api);

    views.push(overlay);

    return { overlay, state, lines: () => plain(overlay.render(100)) };
  };

  return { ...harness, registry, create, openLast };
};

const selected = (lines: string[]) => lines.find((line) => line.startsWith(" ›"));

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

    expect(selected(lines())).toContain("second job");
    expect(state.closed).toBe(false);

    overlay.handleKey(key("escape"));

    expect(state.closed).toBe(true);
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

    await harness.services.require("agentView").open(record.id, { from: "panel" });

    const { overlay, state, lines } = harness.openLast();

    expect(lines().at(-2)?.startsWith(" esc to close")).toBe(true);

    overlay.handleKey(key("escape"));

    expect(state.closed).toBe(true);
  });

  it("a view opened with from list goes back to a new list with that agent selected", async () => {
    const harness = setup();

    harness.create("first job", 1);

    const second: AgentRecord = harness.create("second job", 2);

    await harness.services.require("agentView").open(second.id, { from: "list" });

    const { overlay, state, lines } = harness.openLast();

    expect(lines().at(-2)?.startsWith(" esc to go back")).toBe(true);

    overlay.handleKey(key("escape"));

    expect(lines()[1]).toBe(" Agents · 2 running");
    expect(selected(lines())).toContain("second job");
    expect(state.closed).toBe(false);
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
    await new Promise((done) => setTimeout(done, 1_000));

    expect(state.renders).toBe(renders);
  });
});
