import type { Host } from "../../../core/adapter/contract.ts";
import {
  parseSettings as parseWith,
  projectSettingsPath as projectPath,
  readSettingsFile as readWith,
  type SettingsParse,
  type SettingsSchema,
  userSettingsPath as userPath,
} from "../../../core/manager/settings.ts";
import type { Ratios } from "./thresholds.ts";

export const SETTINGS_FILE = "pi-session-limits.json";

export const defaultRatios = (): Ratios => ({ softRatio: 0.6, hardRatio: 0.75 });

const ratio = { type: "number", min: 0, max: 1, minExclusive: true } as const;

export const settingsSchema: SettingsSchema<Ratios> = { softRatio: ratio, hardRatio: ratio };

export const parseSettings = (raw: unknown, source: string): SettingsParse<Ratios> =>
  parseWith(settingsSchema, raw, source);

export const readSettingsFile = (path: string): SettingsParse<Ratios> => readWith(settingsSchema, path);

export const userSettingsPath = (agentDir: string) => userPath(agentDir, SETTINGS_FILE);

export const projectSettingsPath = (cwd: string) => projectPath(cwd, SETTINGS_FILE);

export type LoadedSettings = { ratios: Ratios; errors: string[] };

export const loadSettings = (agentDir: string, cwd: string, projectTrusted: boolean): LoadedSettings => {
  const user = readSettingsFile(userSettingsPath(agentDir));
  const project = projectTrusted ? readSettingsFile(projectSettingsPath(cwd)) : { patch: {}, errors: [] };

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
