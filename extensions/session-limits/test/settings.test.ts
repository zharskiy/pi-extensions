import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import {
  defaultRatios,
  loadSettings,
  parseSettings,
  projectSettingsPath,
  readSettingsFile,
  userSettingsPath,
  watchSettings,
} from "../src/settings.ts";

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-limits-settings-"));

  return { agentDir: join(root, "agent"), cwd: join(root, "project") };
};

const write = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

describe("parseSettings", () => {
  it("accepts ratios above 0 and at most 1", () => {
    expect(parseSettings({ softRatio: 0.5, hardRatio: 1 }, "f")).toEqual({
      patch: { softRatio: 0.5, hardRatio: 1 },
      errors: [],
    });
  });

  it("reports each invalid value and keeps the valid ones", () => {
    expect(parseSettings({ softRatio: 0, hardRatio: 0.8 }, "f")).toEqual({
      patch: { hardRatio: 0.8 },
      errors: ["f: softRatio must be a number above 0 and at most 1"],
    });
    expect(parseSettings({ hardRatio: "0.7" }, "f").errors).toHaveLength(1);
    expect(parseSettings({ hardRatio: 1.2 }, "f").errors).toHaveLength(1);
    expect(parseSettings([], "f").errors).toEqual(["f: expected a JSON object"]);
  });

  it("ignores unknown keys", () => {
    expect(parseSettings({ other: 1 }, "f")).toEqual({ patch: {}, errors: [] });
  });
});

describe("loadSettings", () => {
  it("uses the defaults without files", () => {
    const { agentDir, cwd } = dirs();

    expect(loadSettings(agentDir, cwd, true)).toEqual({ ratios: defaultRatios(), errors: [] });
  });

  it("lets a trusted project override the user file", () => {
    const { agentDir, cwd } = dirs();

    write(userSettingsPath(agentDir), { softRatio: 0.5, hardRatio: 0.7 });
    write(projectSettingsPath(cwd), { hardRatio: 0.9 });

    expect(loadSettings(agentDir, cwd, true).ratios).toEqual({ softRatio: 0.5, hardRatio: 0.9 });
    expect(loadSettings(agentDir, cwd, false).ratios).toEqual({ softRatio: 0.5, hardRatio: 0.7 });
  });

  it("reports unreadable JSON", () => {
    const { agentDir } = dirs();

    write(userSettingsPath(agentDir), "{ nope");

    expect(readSettingsFile(userSettingsPath(agentDir)).errors[0]).toContain(userSettingsPath(agentDir));
  });
});

describe("watchSettings", () => {
  it("re-reads on session start and reports each invalid value once", () => {
    const { agentDir, cwd } = dirs();
    const host = createFakeHost({ id: "s", cwd, agentDir, projectTrusted: false });
    const ratios = watchSettings(host);

    expect(ratios()).toEqual(defaultRatios());

    write(userSettingsPath(agentDir), { softRatio: 0.4, hardRatio: 2 });
    host.start();
    host.start();

    expect(ratios()).toEqual({ softRatio: 0.4, hardRatio: 0.75 });
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].level).toBe("warning");
    expect(host.notices[0].message).toContain("hardRatio");

    write(userSettingsPath(agentDir), { hardRatio: 0.8 });
    host.start();

    expect(ratios()).toEqual({ softRatio: 0.6, hardRatio: 0.8 });
  });
});
