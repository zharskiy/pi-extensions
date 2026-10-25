import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunMode } from "../../../platform/pi-adapter/index.ts";
import { LIMITS_CHANNEL, userSettingsPath } from "../../../platform/shared/index.ts";
import {
  createFakeAgentRuntime,
  createFakeHost,
  startExtension,
  useTempDirs,
} from "../../../test/framework/index.ts";
import sessionLimits from "../api/extension.ts";
import { DEFAULT_LIMITS, SETTINGS_FILE } from "../core/settings.ts";

const temp = useTempDirs();

const settings = { softRatio: 0.5, hardRatio: 0.7, softTokens: 100_000, hardTokens: 150_000 };

const published = (host: ReturnType<typeof createFakeHost>) =>
  host.published.filter(({ channel }) => channel === LIMITS_CHANNEL).map(({ data }) => data);

const boot = (mode: RunMode) => {
  const host = createFakeHost({ mode });

  startExtension({ extension: sessionLimits, settings, runtime: createFakeAgentRuntime(), host });

  return published(host);
};

describe("session-limits publishing", () => {
  it("publishes its settings on session start", () => {
    expect(boot("tui")).toEqual([settings]);
  });

  it("publishes nothing outside the conversational modes", () => {
    expect(boot("print")).toEqual([]);
    expect(boot("json")).toEqual([]);
  });

  it("publishes the settings reloaded at each new session start", () => {
    const root = temp.make("pi-session-limits-publish-");
    const agentDir = join(root, "agent");
    const host = createFakeHost({ cwd: join(root, "project"), agentDir, projectTrusted: false });

    startExtension({ extension: sessionLimits, runtime: createFakeAgentRuntime(), host });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      userSettingsPath(agentDir, SETTINGS_FILE),
      JSON.stringify({ softRatio: 0.3, hardRatio: 0.4 }),
    );
    host.start();

    expect(published(host)).toEqual([DEFAULT_LIMITS, { ...DEFAULT_LIMITS, softRatio: 0.3, hardRatio: 0.4 }]);
  });
});
