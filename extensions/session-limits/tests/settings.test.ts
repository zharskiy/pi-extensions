import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { userSettingsPath } from "../../../platform/shared/index.ts";
import {
  createFakeAgentRuntime,
  createFakeHost,
  startExtension,
  useTempDirs,
} from "../../../test/framework/index.ts";
import sessionLimits from "../api/extension.ts";
import { SETTINGS_FILE } from "../core/settings.ts";

const temp = useTempDirs();

const load = (settings: object) => {
  const root = temp.make("pi-session-limits-settings-");

  const agentDir = join(root, "agent");
  const file = userSettingsPath(agentDir, SETTINGS_FILE);
  const host = createFakeHost({ id: "s", cwd: join(root, "project"), agentDir, projectTrusted: false });

  mkdirSync(agentDir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings));

  const started = startExtension({ extension: sessionLimits, runtime: createFakeAgentRuntime(), host });

  return { file, host, limits: () => ({ ...started.settings }) };
};

describe("session-limits settings", () => {
  it("reports an invalid ratio and keeps the default", () => {
    const { file, host, limits } = load({ softRatio: 0, hardRatio: 0.8 });

    expect(limits()).toEqual({ softRatio: 0.45, hardRatio: 0.8, softTokens: 125_000, hardTokens: 175_000 });
    expect(host.notices).toEqual([
      {
        message: `pi-session-limits settings: ${file}: softRatio must be a number above 0 and at most 1`,
        level: "warning",
      },
    ]);
  });

  it("fills the token caps from the defaults for a file with only ratios", () => {
    const { host, limits } = load({ softRatio: 0.5, hardRatio: 0.7 });

    expect(limits()).toEqual({ softRatio: 0.5, hardRatio: 0.7, softTokens: 125_000, hardTokens: 175_000 });
    expect(host.notices).toEqual([]);
  });

  it("merges a single token cap with the other defaults", () => {
    const { host, limits } = load({ hardTokens: 300_000 });

    expect(limits()).toEqual({ softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 300_000 });
    expect(host.notices).toEqual([]);
  });

  it("reports an invalid token cap and keeps the default", () => {
    const { file, host, limits } = load({ softTokens: 0, hardTokens: 300_000 });

    expect(limits()).toEqual({ softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 300_000 });
    expect(host.notices).toEqual([
      {
        message: `pi-session-limits settings: ${file}: softTokens must be a number above 0 and at most 100000000`,
        level: "warning",
      },
    ]);
  });
});
