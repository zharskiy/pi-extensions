import {
  applySettings,
  parseSettings as parseWith,
  projectSettingsPath as projectPath,
  readSettingsFile,
  type SettingsParse,
  type SettingsSchema,
  userSettingsPath as userPath,
} from "../../../../core/manager/settings.ts";

export type Settings = {
  maxConcurrent: number;
  maxDepth: number;
  softContextRatio: number;
  hardContextRatio: number;
  reserveTokens: number;
  inlineResultChars: number;
  lingerMs: number;
  failedLingerMs: number;
  renderThrottleMs: number;
  stopGraceSeconds: number;
  maxChainLength: number;
  notifications: boolean;
  disabledPlugins: string[];
};

export const SETTINGS_FILE = "pi-subagents.json";

export const defaultSettings = (): Settings => ({
  maxConcurrent: 4,
  maxDepth: 3,
  softContextRatio: 0.8,
  hardContextRatio: 1.15,
  reserveTokens: 16_384,
  inlineResultChars: 4_000,
  lingerMs: 30_000,
  failedLingerMs: 60_000,
  renderThrottleMs: 250,
  stopGraceSeconds: 60,
  maxChainLength: 3,
  notifications: true,
  disabledPlugins: [],
});

const range = (min: number, max: number) => ({ type: "number", min, max }) as const;

export const settingsSchema: SettingsSchema<Settings> = {
  maxConcurrent: range(1, 64),
  maxDepth: range(2, 4),
  softContextRatio: range(0.1, 1),
  hardContextRatio: range(1, 2),
  reserveTokens: range(0, 200_000),
  inlineResultChars: range(0, 1_000_000),
  lingerMs: range(0, 3_600_000),
  failedLingerMs: range(0, 3_600_000),
  renderThrottleMs: range(0, 10_000),
  stopGraceSeconds: range(0, 3_600),
  maxChainLength: range(1, 20),
  notifications: { type: "boolean" },
  disabledPlugins: { type: "list", of: "plugin ids" },
};

export const parseSettings = (raw: unknown, source: string): SettingsParse<Settings> =>
  parseWith(settingsSchema, raw, source);

const readSettings = (path: string): SettingsParse<Settings> => readSettingsFile(settingsSchema, path);

export const userSettingsPath = (agentDir: string) => userPath(agentDir, SETTINGS_FILE);

export const projectSettingsPath = (cwd: string) => projectPath(cwd, SETTINGS_FILE);

export const disabledPlugins = (agentDir: string) =>
  readSettings(userSettingsPath(agentDir)).patch.disabledPlugins ?? [];

export const loadSettings = (agentDir: string, cwd: string, projectTrusted: boolean) => {
  const user = readSettings(userSettingsPath(agentDir));
  const project: SettingsParse<Settings> = projectTrusted
    ? readSettings(projectSettingsPath(cwd))
    : { patch: {}, errors: [] };
  const { disabledPlugins: ignored, ...projectPatch } = project.patch;
  const errors = [...user.errors, ...project.errors];

  if (ignored !== undefined) {
    errors.push(`${projectSettingsPath(cwd)}: disabledPlugins is read from the user settings file only`);
  }

  return { settings: { ...defaultSettings(), ...user.patch, ...projectPatch }, errors };
};

export { applySettings };
