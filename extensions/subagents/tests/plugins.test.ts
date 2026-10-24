import { describe, expect, it } from "vitest";
import { plugins } from "../api/plugins.ts";
import { createHarness } from "./support/subagents-harness.ts";

describe("subagents plugin set", () => {
  it("enables the plugin set and registers its tools and command", () => {
    const harness = createHarness(plugins);

    expect(harness.errors).toEqual([]);
    expect(harness.host.notices).toEqual([]);
    expect([...harness.host.tools.keys()]).toEqual(["run_agent", "message_agent", "agent_status"]);
    expect([...harness.host.commands.keys()]).toEqual(["agents"]);
  });

  it("skips plugins disabled in settings and names the plugins that needed them", () => {
    const harness = createHarness(plugins, { overrides: { disabledPlugins: ["agent-registry"] } });

    expect(harness.host.tools.size).toBe(0);
    expect(harness.host.commands.has("agents")).toBe(false);
    expect(harness.host.notices).toHaveLength(1);
    expect(harness.host.notices[0]?.message).toContain("agent-panel (needs agent-registry)");
    expect(harness.host.notices[0]?.message).toContain("agent-view (needs agent-registry)");
  });
});
