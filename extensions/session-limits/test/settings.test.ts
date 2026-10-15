import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { userSettingsPath, watchSettings } from "../../../core/manager/settings.ts";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { DEFAULT_RATIOS, SETTINGS_FILE, schema } from "../src/settings.ts";

describe("session-limits settings", () => {
  it("reports an invalid ratio and keeps the default", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-session-limits-settings-"));
    const agentDir = join(root, "agent");
    const file = userSettingsPath(agentDir, SETTINGS_FILE);
    const host = createFakeHost({ id: "s", cwd: join(root, "project"), agentDir, projectTrusted: false });
    const ratios = watchSettings(host, "pi-session-limits", schema, DEFAULT_RATIOS, SETTINGS_FILE);

    mkdirSync(agentDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ softRatio: 0, hardRatio: 0.8 }));
    host.start();

    expect(ratios()).toEqual({ softRatio: 0.6, hardRatio: 0.8 });
    expect(host.notices).toEqual([
      {
        message: `pi-session-limits settings: ${file}: softRatio must be a number above 0 and at most 1`,
        level: "warning",
      },
    ]);

    rmSync(root, { recursive: true, force: true });
  });
});
