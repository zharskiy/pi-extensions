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
  budgetTokens: number;
  softBudgetRatio: number;
  hardBudgetRatio: number;
  reserveTokens: number;
  inlineResultChars: number;
  lingerMs: number;
  failedLingerMs: number;
  renderThrottleMs: number;
  stopGraceSeconds: number;
  maxChainLength: number;
  disabledPlugins: string[];
};

export const SETTINGS_FILE = "pi-subagents.json";

export const defaultSettings = (): Settings => ({
  maxConcurrent: 4,
  maxDepth: 3,
  budgetTokens: 100_000,
  softBudgetRatio: 0.8,
  hardBudgetRatio: 1.15,
  reserveTokens: 16_384,
  inlineResultChars: 4_000,
  lingerMs: 30_000,
  failedLingerMs: 60_000,
  renderThrottleMs: 250,
  stopGraceSeconds: 60,
  maxChainLength: 3,
  disabledPlugins: [],
});

const range = (min: number, max: number) => ({ type: "number", min, max }) as const;

export const settingsSchema: SettingsSchema<Settings> = {
  maxConcurrent: range(1, 64),
  maxDepth: range(2, 4),
  budgetTokens: range(5_000, 2_000_000),
  softBudgetRatio: range(0.1, 1),
  hardBudgetRatio: range(1, 2),
  reserveTokens: range(0, 200_000),
  inlineResultChars: range(0, 1_000_000),
  lingerMs: range(0, 3_600_000),
  failedLingerMs: range(0, 3_600_000),
  renderThrottleMs: range(0, 10_000),
  stopGraceSeconds: range(0, 3_600),
  maxChainLength: range(1, 20),
  disabledPlugins: { type: "list", of: "plugin ids" },
};

export const parseSettings = (raw: unknown, source: string): SettingsParse<Settings> =>
  parseWith(settingsSchema, raw, source);

export const readSettings = (path: string): SettingsParse<Settings> => readSettingsFile(settingsSchema, path);

export const userSettingsPath = (agentDir: string) => userPath(agentDir, SETTINGS_FILE);

export const projectSettingsPath = (cwd: string) => projectPath(cwd, SETTINGS_FILE);

export { applySettings };
