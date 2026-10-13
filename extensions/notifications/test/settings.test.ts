import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSettingsPath, userSettingsPath } from "../../../core/manager/settings.ts";
import { loadSettings, SETTINGS_FILE } from "../src/settings.ts";

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-notifications-settings-"));

  return { agentDir: join(root, "agent"), cwd: join(root, "project") };
};

const write = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
};

const withFiles = () => {
  const { agentDir, cwd } = dirs();

  write(userSettingsPath(agentDir, SETTINGS_FILE), { channel: "bell", idleDelayMs: 1_000 });
  write(projectSettingsPath(cwd, SETTINGS_FILE), { idleDelayMs: 2_000 });

  return { agentDir, cwd };
};

describe("notifications settings", () => {
  it("has the defaults", () => {
    const { agentDir, cwd } = dirs();

    expect(loadSettings(agentDir, cwd, true)).toEqual({
      settings: { channel: "auto", idleDelayMs: 20_000, dialogDelayMs: 6_000 },
      errors: [],
    });
  });

  it("merges the user file and a trusted project file, project last", () => {
    const { agentDir, cwd } = withFiles();

    expect(loadSettings(agentDir, cwd, true).settings).toEqual({
      channel: "bell",
      idleDelayMs: 2_000,
      dialogDelayMs: 6_000,
    });
  });

  it("ignores the project file when the project is not trusted", () => {
    const { agentDir, cwd } = withFiles();

    expect(loadSettings(agentDir, cwd, false).settings).toMatchObject({ idleDelayMs: 1_000 });
  });
});
