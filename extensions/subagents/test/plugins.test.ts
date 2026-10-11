import { describe, expect, it } from "vitest";
import { plugins } from "../src/plugins.ts";
import { createHarness } from "./helpers/harness.ts";

describe("subagents plugin set", () => {
  it("enables the release 0.2 plugin set and reports everything it adds to pi", () => {
    const harness = createHarness(plugins);
    const report = harness.manager.report();

    expect(report.enabled).toEqual([
      "agent-registry",
      "agent-definitions",
      "handoff",
      "run-agent",
      "usage-report",
      "agent-status",
      "limits",
      "progress-widget",
      "agent-view",
      "agent-list-view",
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

  it("skips plugins disabled in settings and the plugins that need them", () => {
    const harness = createHarness(plugins, { disabledPlugins: ["agent-view"] });

    expect(harness.manager.report().skipped).toEqual([
      { id: "agent-view", reason: "disabled in settings" },
      { id: "agent-list-view", reason: "requires agent-view" },
    ]);
  });
});
