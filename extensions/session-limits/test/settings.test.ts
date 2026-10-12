import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSettingsPath, userSettingsPath } from "../../../core/manager/settings.ts";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { watchSettings } from "../src/settings.ts";

const SETTINGS_FILE = "pi-session-limits.json";
const userFile = (agentDir: string) => userSettingsPath(agentDir, SETTINGS_FILE);
const projectFile = (cwd: string) => projectSettingsPath(cwd, SETTINGS_FILE);

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-limits-settings-"));

  return { agentDir: join(root, "agent"), cwd: join(root, "project") };
};

const write = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

const loadSettings = (agentDir: string, cwd: string, projectTrusted: boolean) => {
  const host = createFakeHost({ id: "s", cwd, agentDir, projectTrusted });
  const ratios = watchSettings(host);

  host.start();

  return { ratios: ratios(), errors: host.notices.map((notice) => notice.message) };
};

describe("loadSettings", () => {
  it("uses the defaults without files", () => {
    const { agentDir, cwd } = dirs();

    expect(loadSettings(agentDir, cwd, true)).toEqual({
      ratios: { softRatio: 0.6, hardRatio: 0.75 },
      errors: [],
    });
  });

  it("lets a trusted project override the user file", () => {
    const { agentDir, cwd } = dirs();

    write(userFile(agentDir), { softRatio: 0.5, hardRatio: 0.7 });
    write(projectFile(cwd), { hardRatio: 0.9 });

    expect(loadSettings(agentDir, cwd, true).ratios).toEqual({ softRatio: 0.5, hardRatio: 0.9 });
    expect(loadSettings(agentDir, cwd, false).ratios).toEqual({ softRatio: 0.5, hardRatio: 0.7 });
  });

  it("reports an invalid ratio and keeps the default", () => {
    const { agentDir, cwd } = dirs();

    write(userFile(agentDir), { softRatio: 0, hardRatio: 0.8 });

    const loaded = loadSettings(agentDir, cwd, false);

    expect(loaded.ratios).toEqual({ softRatio: 0.6, hardRatio: 0.8 });
    expect(loaded.errors).toEqual([
      `pi-session-limits settings: ${userFile(agentDir)}: softRatio must be a number above 0 and at most 1`,
    ]);
  });

  it("reports unreadable JSON", () => {
    const { agentDir } = dirs();

    write(userFile(agentDir), "{ nope");

    expect(loadSettings(agentDir, "/nowhere", false).errors[0]).toContain(userFile(agentDir));
  });
});

describe("watchSettings", () => {
  it("re-reads on session start and reports each invalid value once", () => {
    const { agentDir, cwd } = dirs();
    const host = createFakeHost({ id: "s", cwd, agentDir, projectTrusted: false });
    const ratios = watchSettings(host);

    expect(ratios()).toEqual({ softRatio: 0.6, hardRatio: 0.75 });

    write(userFile(agentDir), { softRatio: 0.4, hardRatio: 2 });
    host.start();
    host.start();

    expect(ratios()).toEqual({ softRatio: 0.4, hardRatio: 0.75 });
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].level).toBe("warning");
    expect(host.notices[0].message).toContain("hardRatio");

    write(userFile(agentDir), { hardRatio: 0.8 });
    host.start();

    expect(ratios()).toEqual({ softRatio: 0.6, hardRatio: 0.8 });
  });
});
