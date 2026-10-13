import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, disabledPlugins, loadSettings } from "../../src/model/settings.ts";
import { tempDir } from "../helpers/harness.ts";

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const dirs = () => {
  const root = tempDir();
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");

  return {
    agentDir,
    cwd,
    userFile: join(agentDir, "pi-subagents.json"),
    projectFile: join(cwd, ".pi", "pi-subagents.json"),
  };
};

describe("subagents settings", () => {
  it("validates ranges and types, keeps valid values and ignores unknown keys", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, {
      maxConcurrent: 8,
      maxDepth: 5,
      softContextRatio: "big",
      stopGraceSeconds: "soon",
      somethingElse: 50_000,
    });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings).toMatchObject({ maxConcurrent: 8, maxDepth: 3, softContextRatio: 0.8 });
    expect(loaded.errors).toEqual([
      `${userFile}: maxDepth must be a number between 2 and 4`,
      `${userFile}: softContextRatio must be a number between 0.1 and 1`,
      `${userFile}: stopGraceSeconds must be a number between 0 and 3600`,
    ]);
  });

  it("rejects a disabled plugin list that is not a list of ids", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, { disabledPlugins: "agent-view" });

    expect(loadSettings(agentDir, cwd, false).errors).toEqual([
      `${userFile}: disabledPlugins must be a list of plugin ids`,
    ]);
    expect(disabledPlugins(agentDir)).toEqual([]);
  });

  it("has a chain length of 3 by default", () => {
    expect(defaultSettings()).toMatchObject({ maxChainLength: 3 });
    expect(defaultSettings()).not.toHaveProperty("notifications");
  });

  it("defaults the panel lingers and the agents hint", () => {
    expect(defaultSettings()).toMatchObject({
      doneLingerMs: 10_000,
      failedLingerMs: 30_000,
      agentsHintMs: 30_000,
    });
  });

  it("rejects doneLingerMs and agentsHintMs outside 0–3600000", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, { doneLingerMs: -1, agentsHintMs: 3_600_001 });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings).toMatchObject({ doneLingerMs: 10_000, agentsHintMs: 30_000 });
    expect(loaded.errors).toEqual([
      `${userFile}: doneLingerMs must be a number between 0 and 3600000`,
      `${userFile}: agentsHintMs must be a number between 0 and 3600000`,
    ]);
  });

  it("merges defaults, the user file and a trusted project file, project last", () => {
    const { agentDir, cwd, userFile, projectFile } = dirs();

    writeJson(userFile, { maxConcurrent: 2, maxDepth: 4 });
    writeJson(projectFile, { maxConcurrent: 6 });

    expect(loadSettings(agentDir, cwd, true).settings).toMatchObject({ maxConcurrent: 6, maxDepth: 4 });
    expect(loadSettings(agentDir, cwd, false).settings).toMatchObject({ maxConcurrent: 2, maxDepth: 4 });
  });

  it("reads disabledPlugins from the user file only and warns when the project file sets it", () => {
    const { agentDir, cwd, userFile, projectFile } = dirs();

    writeJson(userFile, { disabledPlugins: ["agent-view"] });
    writeJson(projectFile, { disabledPlugins: ["run-agent"] });

    const loaded = loadSettings(agentDir, cwd, true);

    expect(disabledPlugins(agentDir)).toEqual(["agent-view"]);
    expect(loaded.settings.disabledPlugins).toEqual(["agent-view"]);
    expect(loaded.errors).toEqual([
      `${projectFile}: disabledPlugins is read from the user settings file only`,
    ]);
  });
});
