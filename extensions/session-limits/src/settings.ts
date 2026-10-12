import type { Host } from "../../../core/adapter/contract.ts";
import {
  projectSettingsPath,
  readSettingsFile,
  type SettingsSchema,
  userSettingsPath,
} from "../../../core/manager/settings.ts";
import type { Ratios } from "./thresholds.ts";

const SETTINGS_FILE = "pi-session-limits.json";

export const defaultRatios = (): Ratios => ({ softRatio: 0.6, hardRatio: 0.75 });

const ratio = { type: "number", min: 0, max: 1, minExclusive: true } as const;

const schema: SettingsSchema<Ratios> = { softRatio: ratio, hardRatio: ratio };

export const loadSettings = (agentDir: string, cwd: string, projectTrusted: boolean) => {
  const user = readSettingsFile(schema, userSettingsPath(agentDir, SETTINGS_FILE));

  const project = projectTrusted
    ? readSettingsFile(schema, projectSettingsPath(cwd, SETTINGS_FILE))
    : { patch: {}, errors: [] };

  return {
    ratios: { ...defaultRatios(), ...user.patch, ...project.patch },
    errors: [...user.errors, ...project.errors],
  };
};

export const watchSettings = (host: Host): (() => Ratios) => {
  let ratios = defaultRatios();
  const reported = new Set<string>();

  host.onSessionStart((info) => {
    const loaded = loadSettings(info.agentDir, info.cwd, info.projectTrusted);

    ratios = loaded.ratios;

    loaded.errors
      .filter((error) => !reported.has(error))
      .forEach((error) => {
        reported.add(error);
        host.ui.notify(`pi-session-limits settings: ${error}`, "warning");
      });
  });

  return () => ratios;
};
