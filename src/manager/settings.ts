import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  disabledPlugins: [],
});

type NumberRule = { key: keyof Settings; min: number; max: number };

const numberRules: NumberRule[] = [
  { key: "maxConcurrent", min: 1, max: 64 },
  { key: "maxDepth", min: 2, max: 4 },
  { key: "budgetTokens", min: 5_000, max: 2_000_000 },
  { key: "softBudgetRatio", min: 0.1, max: 1 },
  { key: "hardBudgetRatio", min: 1, max: 2 },
  { key: "reserveTokens", min: 0, max: 200_000 },
  { key: "inlineResultChars", min: 0, max: 1_000_000 },
  { key: "lingerMs", min: 0, max: 3_600_000 },
  { key: "failedLingerMs", min: 0, max: 3_600_000 },
  { key: "renderThrottleMs", min: 0, max: 10_000 },
  { key: "stopGraceSeconds", min: 0, max: 3_600 },
];

export type SettingsParse = { patch: Partial<Settings>; errors: string[] };

export const parseSettings = (raw: unknown, source: string): SettingsParse => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { patch: {}, errors: [`${source}: expected a JSON object`] };
  }

  const input = raw as Record<string, unknown>;
  const errors: string[] = [];
  const patch: Partial<Settings> = {};

  numberRules
    .filter((rule) => input[rule.key] !== undefined)
    .forEach((rule) => {
      const value = input[rule.key];
      const valid = typeof value === "number" && value >= rule.min && value <= rule.max;

      if (!valid) {
        errors.push(`${source}: ${rule.key} must be a number between ${rule.min} and ${rule.max}`);
        return;
      }

      Object.assign(patch, { [rule.key]: value });
    });

  const disabled = input.disabledPlugins;

  if (disabled !== undefined) {
    const valid = Array.isArray(disabled) && disabled.every((entry) => typeof entry === "string");

    if (valid) {
      patch.disabledPlugins = disabled as string[];
    } else {
      errors.push(`${source}: disabledPlugins must be a list of plugin ids`);
    }
  }

  return { patch, errors };
};

export const readSettingsFile = (path: string): SettingsParse => {
  if (!existsSync(path)) {
    return { patch: {}, errors: [] };
  }

  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    return { patch: {}, errors: [`${path}: ${(error as Error).message}`] };
  }
};

export const userSettingsPath = (agentDir: string) => join(agentDir, SETTINGS_FILE);

export const projectSettingsPath = (cwd: string) => join(cwd, ".pi", SETTINGS_FILE);

export const applySettings = (settings: Settings, patch: Partial<Settings>) => {
  Object.assign(settings, patch);

  return settings;
};
