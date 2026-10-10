import { describe, expect, it } from "vitest";
import { createBus } from "../../src/manager/bus.ts";
import { orderPlugins } from "../../src/manager/extension-manager.ts";
import type { Plugin } from "../../src/manager/plugin.ts";
import { parseSettings } from "../../src/manager/settings.ts";
import { plugins } from "../../src/plugins.ts";
import { createHarness } from "../helpers/harness.ts";

const stub = (id: string, requires: string[] = [], log: string[] = []): Plugin => ({
  id,
  requires,
  enable: () => {
    log.push(`enable ${id}`);
    return () => {
      log.push(`disable ${id}`);
    };
  },
});

describe("extension manager", () => {
  it("enables the release 0.1 plugin set and reports everything it adds to pi", () => {
    const harness = createHarness(plugins);
    const report = harness.manager.report();

    expect(report.enabled).toEqual([
      "spending",
      "agent-registry",
      "agent-definitions",
      "handoff",
      "run-agent",
      "agent-status",
      "limits",
      "progress-widget",
      "agent-view",
    ]);
    expect(report.skipped).toEqual([]);
    expect(report.contributions.filter((entry) => entry.kind !== "prompt-section")).toEqual([
      { plugin: "agent-definitions", kind: "main-prompt", name: "main-session" },
      { plugin: "run-agent", kind: "tool", name: "run_agent" },
      { plugin: "run-agent", kind: "tool", name: "message_agent" },
      { plugin: "agent-status", kind: "tool", name: "agent_status" },
      { plugin: "agent-view", kind: "command", name: "agents" },
    ]);
    expect([...harness.host.tools.keys()]).toEqual(["run_agent", "message_agent", "agent_status"]);
  });

  it("orders plugins by their requirements", () => {
    const ordered = orderPlugins([stub("c", ["b"]), stub("b", ["a"]), stub("a")]);

    expect(ordered.map((plugin) => plugin.id)).toEqual(["a", "b", "c"]);
  });

  it("skips disabled plugins and the plugins that need them, and disables in reverse order", async () => {
    const log: string[] = [];
    const harness = createHarness([stub("a", [], log), stub("b", ["a"], log), stub("c", [], log)], {
      disabledPlugins: ["a"],
    });

    expect(harness.manager.report().skipped).toEqual([
      { id: "a", reason: "disabled in settings" },
      { id: "b", reason: "requires a" },
    ]);

    const all = createHarness([stub("x", [], log), stub("y", ["x"], log)]);

    await all.manager.disableAll();

    expect(log).toEqual(["enable c", "enable x", "enable y", "disable y", "disable x"]);
  });

  it("rejects dependency cycles", () => {
    expect(() => orderPlugins([stub("a", ["b"]), stub("b", ["a"])])).toThrow(/cycle/);
  });
});

describe("bus", () => {
  it("isolates listener errors and supports unsubscribe", () => {
    const errors: unknown[] = [];
    const bus = createBus((error) => errors.push(error));
    const seen: string[] = [];

    bus.on("spend:changed", () => {
      throw new Error("boom");
    });

    const off = bus.on("spend:changed", ({ agentId }) => seen.push(agentId));

    bus.emit("spend:changed", { agentId: "a" });
    off();
    bus.emit("spend:changed", { agentId: "b" });

    expect(seen).toEqual(["a"]);
    expect(errors).toHaveLength(2);
  });
});

describe("settings", () => {
  it("validates ranges and types and keeps valid values", () => {
    const parsed = parseSettings(
      {
        maxConcurrent: 8,
        maxDepth: 5,
        budgetTokens: "big",
        disabledPlugins: ["agent-view"],
      },
      "pi-subagents.json",
    );

    expect(parsed.patch).toEqual({ maxConcurrent: 8, disabledPlugins: ["agent-view"] });
    expect(parsed.errors).toEqual([
      "pi-subagents.json: maxDepth must be a number between 2 and 4",
      "pi-subagents.json: budgetTokens must be a number between 5000 and 2000000",
    ]);
  });
});
