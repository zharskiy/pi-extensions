import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAgentRuntime } from "../../../../test/framework/index.ts";
import { defaultSettings, disabledPlugins, loadSettings, reloadSettings } from "../../core/model/settings.ts";
import { tempDir } from "../support/subagents-harness.ts";

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

  it("accepts a retentionDays of 0 to keep agent runs forever", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, { retentionDays: 0 });

    expect(loadSettings(agentDir, cwd, false).settings.retentionDays).toBe(0);
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
      maxChildrenPerAgent: 6,
      fetchTimeoutSeconds: 20,
      fetchMaxBytes: 5_000_000,
      fetchMaxChars: 40_000,
    });
  });

  it("accepts valid delegation and fetch settings", () => {
    const { agentDir, cwd, userFile } = dirs();
    const values = {
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
      maxChildrenPerAgent: 51,
      fetchTimeoutSeconds: 0,
      fetchMaxBytes: 9_999,
      fetchMaxChars: "lots",
    });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings).toMatchObject({
      maxChildrenPerAgent: 6,
      fetchTimeoutSeconds: 20,
      fetchMaxBytes: 5_000_000,
      fetchMaxChars: 40_000,
    });
    expect(loaded.errors).toEqual([
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

  it("has no agent overrides by default", () => {
    expect(defaultSettings().agents).toEqual({});
  });

  it("parses agent overrides, splitting a model's thinking suffix, an explicit thinking winning", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, {
      agents: {
        scout: { model: "acme/x:high" },
        planner: { model: "acme/y:high", thinking: "low", skills: ["docs", "docs"] },
        general: { model: "inherit", skills: "all" },
      },
    });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.errors).toEqual([]);
    expect(loaded.settings.agents).toEqual({
      scout: { model: "acme/x", thinking: "high" },
      planner: { model: "acme/y", thinking: "low", skills: ["docs"] },
      general: { model: "inherit", skills: "all" },
    });
  });

  it("reports invalid override fields and keeps the valid ones", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, {
      agents: {
        scout: { model: "a b", thinking: "loud", skills: "some", tools: ["read"] },
        planner: "fast",
        reviewer: { model: "acme/x:extreme", thinking: "max" },
      },
    });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.settings.agents).toEqual({ scout: {}, reviewer: { thinking: "max" } });
    expect(loaded.errors).toEqual([
      `${userFile}: agents.scout.tools cannot be overridden (only model, thinking, skills); create an own agent instead`,
      `${userFile}: agents.scout.model must be provider/id[:thinking] or inherit, without spaces`,
      `${userFile}: agents.scout.thinking must be one of off, minimal, low, medium, high, xhigh, max`,
      `${userFile}: agents.scout.skills must be "all" or a list of skill names`,
      `${userFile}: agents.planner must be an object with model, thinking, skills`,
      `${userFile}: agents.reviewer.model: invalid thinking level "extreme" in "acme/x:extreme"; use one of off, minimal, low, medium, high, xhigh, max`,
    ]);
  });

  it("rejects agents that is not an object", () => {
    const { agentDir, cwd, userFile } = dirs();

    writeJson(userFile, { agents: ["scout"] });

    expect(loadSettings(agentDir, cwd, false).errors).toEqual([
      `${userFile}: agents must be an object of agent overrides`,
    ]);
  });

  it("merges agent overrides per agent and field, the trusted project last", () => {
    const { agentDir, cwd, userFile, projectFile } = dirs();

    writeJson(userFile, {
      agents: { scout: { model: "acme/u", skills: ["docs"] }, planner: { thinking: "low" } },
    });
    writeJson(projectFile, { agents: { scout: { model: "acme/p:high" }, reviewer: { skills: [] } } });

    expect(loadSettings(agentDir, cwd, true).settings.agents).toEqual({
      scout: { model: "acme/p", thinking: "high", skills: ["docs"] },
      planner: { thinking: "low" },
      reviewer: { skills: [] },
    });
    expect(loadSettings(agentDir, cwd, false).settings.agents).toEqual({
      scout: { model: "acme/u", skills: ["docs"] },
      planner: { thinking: "low" },
    });
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

  it("reads retentionDays from the user file only and warns when the project file sets it", () => {
    const { agentDir, cwd, userFile, projectFile } = dirs();

    writeJson(userFile, { retentionDays: 30 });
    writeJson(projectFile, { retentionDays: 1 });

    const loaded = loadSettings(agentDir, cwd, true);

    expect(loaded.settings.retentionDays).toBe(30);
    expect(loaded.errors).toEqual([`${projectFile}: retentionDays is read from the user settings file only`]);
  });
});

describe("codemode workers on settings reload", () => {
  it("asks for maxConcurrent agent sessions, whatever maxDepth, and stays quiet without a shortfall", () => {
    const { agentDir, cwd, userFile } = dirs();
    const runtime = createFakeAgentRuntime();
    const warnings: string[] = [];

    writeJson(userFile, { maxConcurrent: 5, maxDepth: 4 });
    reloadSettings(defaultSettings(), { agentDir, cwd, projectTrusted: false }, runtime, (message) =>
      warnings.push(message),
    );

    expect(runtime.workerRequests).toEqual([5]);
    expect(warnings).toEqual([]);
  });

  it("warns about a shortfall once per settings object, applying the request on every reload", () => {
    const { agentDir, cwd } = dirs();
    const runtime = createFakeAgentRuntime();
    const settings = defaultSettings();
    const warnings: string[] = [];
    const info = { agentDir, cwd, projectTrusted: false };

    runtime.codemodeShortfall = { setting: "FAKE_WORKERS", workers: 3, wanted: 14 };
    reloadSettings(settings, info, runtime, (message) => warnings.push(message));
    reloadSettings(settings, info, runtime, (message) => warnings.push(message));

    expect(runtime.workerRequests).toEqual([12, 12]);
    expect(warnings).toEqual([
      "FAKE_WORKERS=3 is below the 14 codemode workers the agents may need; agents' codemode scripts may wait or fail",
    ]);
  });
});
