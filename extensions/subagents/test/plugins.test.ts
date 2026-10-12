import { describe, expect, it } from "vitest";
import { plugins } from "../src/plugins.ts";
import { createHarness } from "./helpers/harness.ts";

describe("subagents plugin set", () => {
  it("enables the release 0.3 plugin set and registers its tools and command", () => {
    const harness = createHarness(plugins);

    expect(harness.errors).toEqual([]);
    expect(harness.host.notices).toEqual([]);
    expect([...harness.host.tools.keys()]).toEqual(["run_agent", "message_agent", "agent_status"]);
    expect([...harness.host.commands.keys()]).toEqual(["agents"]);
  });

  it("skips plugins disabled in settings and tells the user about the plugins that need them", () => {
    const harness = createHarness(plugins, { disabledPlugins: ["agent-view"] });

    expect(harness.host.commands.has("agents")).toBe(false);
    expect(harness.host.notices).toEqual([
      {
        message: "plugins skipped because a plugin they need is off: agent-list-view (needs agent-view)",
        level: "warning",
      },
    ]);
  });
});
