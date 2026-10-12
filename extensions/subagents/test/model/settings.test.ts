import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  parseSettings,
  projectSettingsPath,
  userSettingsPath,
} from "../../src/model/settings.ts";

describe("subagents settings", () => {
  it("validates ranges and types and keeps valid values", () => {
    const parsed = parseSettings(
      {
        maxConcurrent: 8,
        maxDepth: 5,
        softContextRatio: "big",
        disabledPlugins: ["agent-view"],
      },
      "pi-subagents.json",
    );

    expect(parsed.patch).toEqual({ maxConcurrent: 8, disabledPlugins: ["agent-view"] });
    expect(parsed.errors).toEqual([
      "pi-subagents.json: maxDepth must be a number between 2 and 4",
      "pi-subagents.json: softContextRatio must be a number between 0.1 and 1",
    ]);
  });

  it("ignores unknown keys without an error", () => {
    const parsed = parseSettings({ somethingElse: 50_000, hardContextRatio: 1.2 }, "f");

    expect(parsed.patch).toEqual({ hardContextRatio: 1.2 });
    expect(parsed.errors).toEqual([]);
  });

  it("rejects a disabled plugin list that is not a list of ids", () => {
    expect(parseSettings({ disabledPlugins: "agent-view" }, "f").errors).toEqual([
      "f: disabledPlugins must be a list of plugin ids",
    ]);
  });

  it("takes notifications as a switch, on by default", () => {
    expect(defaultSettings().notifications).toBe(true);
    expect(parseSettings({ notifications: false }, "f").patch).toEqual({ notifications: false });
    expect(parseSettings({ notifications: "off" }, "f").errors).toEqual([
      "f: notifications must be true or false",
    ]);
  });

  it("reads pi-subagents.json from the agent dir and the project", () => {
    expect(userSettingsPath("/agent")).toBe("/agent/pi-subagents.json");
    expect(projectSettingsPath("/project")).toBe("/project/.pi/pi-subagents.json");
    expect(defaultSettings().maxChainLength).toBe(3);
  });
});
