import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type NumberRule = { type: "number"; min: number; max: number; minExclusive?: boolean };

export type ListRule = { type: "list"; of: string };

export type BooleanRule = { type: "boolean" };

export type SettingsRule = NumberRule | ListRule | BooleanRule;

export type SettingsSchema<T> = { [K in keyof T]?: SettingsRule };

export type SettingsParse<T> = { patch: Partial<T>; errors: string[] };

const validNumber = (rule: NumberRule, value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  (rule.minExclusive ? value > rule.min : value >= rule.min) &&
  value <= rule.max;

const validList = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isValid = (rule: SettingsRule, value: unknown) => {
  if (rule.type === "boolean") {
    return typeof value === "boolean";
  }

  return rule.type === "number" ? validNumber(rule, value) : validList(value);
};

const expectation = (rule: SettingsRule) => {
  if (rule.type === "boolean") {
    return "true or false";
  }

  if (rule.type === "list") {
    return `a list of ${rule.of}`;
  }

  return rule.minExclusive
    ? `a number above ${rule.min} and at most ${rule.max}`
    : `a number between ${rule.min} and ${rule.max}`;
};

export const parseSettings = <T>(
  schema: SettingsSchema<T>,
  raw: unknown,
  source: string,
): SettingsParse<T> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { patch: {}, errors: [`${source}: expected a JSON object`] };
  }

  const input = raw as Record<string, unknown>;
  const patch: Partial<T> = {};
  const errors: string[] = [];

  Object.entries(schema as Record<string, SettingsRule | undefined>)
    .filter(([key, rule]) => rule !== undefined && input[key] !== undefined)
    .forEach(([key, rule]) => {
      const value = input[key];

      if (!rule || !isValid(rule, value)) {
        errors.push(`${source}: ${key} must be ${rule ? expectation(rule) : "valid"}`);
        return;
      }

      Object.assign(patch, { [key]: value });
    });

  return { patch, errors };
};

export const readSettingsFile = <T>(schema: SettingsSchema<T>, path: string): SettingsParse<T> => {
  if (!existsSync(path)) {
    return { patch: {}, errors: [] };
  }

  try {
    return parseSettings(schema, JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    return { patch: {}, errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
};

export const userSettingsPath = (agentDir: string, file: string) => join(agentDir, file);

export const projectSettingsPath = (cwd: string, file: string) => join(cwd, ".pi", file);

export const applySettings = <T extends object>(settings: T, patch: Partial<T>) => {
  Object.assign(settings, patch);

  return settings;
};
