import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "../adapter/contract.ts";
import { errorText } from "./format.ts";

type NumberRule = { type: "number"; min: number; max: number; minExclusive?: boolean };

type ListRule = { type: "list"; of: string };

type BooleanRule = { type: "boolean" };

type ChoiceRule = { type: "choice"; values: readonly string[] };

type SettingsRule = NumberRule | ListRule | BooleanRule | ChoiceRule;

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

  if (rule.type === "choice") {
    return typeof value === "string" && rule.values.includes(value);
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

  if (rule.type === "choice") {
    return `one of ${rule.values.map((value) => `"${value}"`).join(", ")}`;
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

  Object.entries(schema as Record<string, SettingsRule>)
    .filter(([key]) => input[key] !== undefined)
    .forEach(([key, rule]) => {
      const value = input[key];

      if (!isValid(rule, value)) {
        errors.push(`${source}: ${key} must be ${expectation(rule)}`);
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
    return { patch: {}, errors: [`${path}: ${errorText(error)}`] };
  }
};

export const userSettingsPath = (agentDir: string, file: string) => join(agentDir, file);

export const projectSettingsPath = (cwd: string, file: string) => join(cwd, ".pi", file);

export type SettingsLocation = { agentDir: string; cwd: string; projectTrusted: boolean };

export const readSettingsFiles = <T>(schema: SettingsSchema<T>, file: string, location: SettingsLocation) => {
  const user = readSettingsFile(schema, userSettingsPath(location.agentDir, file));

  const project: SettingsParse<T> = location.projectTrusted
    ? readSettingsFile(schema, projectSettingsPath(location.cwd, file))
    : { patch: {}, errors: [] };

  return { user: user.patch, project: project.patch, errors: [...user.errors, ...project.errors] };
};

export const loadSettingsFiles = <T>(
  schema: SettingsSchema<T>,
  defaults: T,
  file: string,
  location: SettingsLocation,
) => {
  const { user, project, errors } = readSettingsFiles(schema, file, location);

  return { settings: { ...defaults, ...user, ...project }, errors };
};

export const reportSettingsErrors = (host: Host, label: string) => {
  const reported = new Set<string>();

  return (errors: readonly string[]) =>
    errors
      .filter((error) => !reported.has(error))
      .forEach((error) => {
        reported.add(error);
        host.ui.notify(`${label} settings: ${error}`, "warning");
      });
};

export const watchSettings = <T>(
  host: Host,
  label: string,
  schema: SettingsSchema<T>,
  defaults: T,
  file: string,
): (() => T) => {
  const report = reportSettingsErrors(host, label);
  let settings = defaults;

  host.onSessionStart((info) => {
    const loaded = loadSettingsFiles(schema, defaults, file, info);

    settings = loaded.settings;
    report(loaded.errors);
  });

  return () => settings;
};
