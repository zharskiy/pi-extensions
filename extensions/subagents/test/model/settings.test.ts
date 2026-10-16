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
  });

  it("defaults the panel lingers", () => {
    expect(defaultSettings()).toMatchObject({
      doneLingerMs: 10_000,
      failedLingerMs: 30_000,
    });
  });

  it("rejects doneLingerMs outside 0–3600000", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, { doneLingerMs: -1 });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings).toMatchObject({ doneLingerMs: 10_000 });
    expect(loaded.errors).toEqual([`${userFile}: doneLingerMs must be a number between 0 and 3600000`]);
  });

  it("defaults the delegation and fetch settings", () => {
    expect(defaultSettings()).toMatchObject({
      delegateOnly: true,
      delegateOnlyTools: ["read", "write", "questionnaire"],
      maxChildrenPerAgent: 6,
      fetchTimeoutSeconds: 20,
      fetchMaxBytes: 5_000_000,
      fetchMaxChars: 40_000,
    });
  });

  it("accepts valid delegation and fetch settings", () => {
    const { agentDir, cwd, userFile } = dirs();
    const values = {
      delegateOnly: false,
      delegateOnlyTools: ["read"],
      maxChildrenPerAgent: 0,
      fetchTimeoutSeconds: 300,
      fetchMaxBytes: 10_000,
      fetchMaxChars: 1_000_000,
    };

    writeJson(userFile, values);

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings).toMatchObject(values);
    expect(loaded.errors).toEqual([]);
  });

  it("drops out-of-range and wrong-type delegation and fetch settings with a warning", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, {
      delegateOnly: "yes",
      delegateOnlyTools: "read",
      maxChildrenPerAgent: 51,
      fetchTimeoutSeconds: 0,
      fetchMaxBytes: 9_999,
      fetchMaxChars: "lots",
    });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings).toMatchObject({
      delegateOnly: true,
      delegateOnlyTools: ["read", "write", "questionnaire"],
      maxChildrenPerAgent: 6,
      fetchTimeoutSeconds: 20,
      fetchMaxBytes: 5_000_000,
      fetchMaxChars: 40_000,
    });
    expect(loaded.errors).toEqual([
      `${userFile}: delegateOnly must be true or false`,
      `${userFile}: delegateOnlyTools must be a list of tool names`,
      `${userFile}: maxChildrenPerAgent must be a number between 0 and 50`,
      `${userFile}: fetchTimeoutSeconds must be a number between 1 and 300`,
      `${userFile}: fetchMaxBytes must be a number between 10000 and 100000000`,
      `${userFile}: fetchMaxChars must be a number between 1000 and 1000000`,
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
