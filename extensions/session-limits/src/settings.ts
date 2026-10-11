import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "./adapter/contract.ts";
import type { Ratios } from "./thresholds.ts";

export const SETTINGS_FILE = "pi-session-limits.json";

export const defaultRatios = (): Ratios => ({ softRatio: 0.6, hardRatio: 0.75 });

export type SettingsParse = { patch: Partial<Ratios>; errors: string[] };

const RATIO_KEYS: (keyof Ratios)[] = ["softRatio", "hardRatio"];

const isRatio = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;

export const parseSettings = (raw: unknown, source: string): SettingsParse => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { patch: {}, errors: [`${source}: expected a JSON object`] };
  }

  const input = raw as Record<string, unknown>;
  const patch: Partial<Ratios> = {};
  const errors: string[] = [];

  RATIO_KEYS.filter((key) => input[key] !== undefined).forEach((key) => {
    const value = input[key];

    if (!isRatio(value)) {
      errors.push(`${source}: ${key} must be a number above 0 and at most 1`);
      return;
    }

    patch[key] = value;
  });

  return { patch, errors };
};

export const readSettingsFile = (path: string): SettingsParse => {
  if (!existsSync(path)) {
    return { patch: {}, errors: [] };
  }

  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    return { patch: {}, errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
};

export const userSettingsPath = (agentDir: string) => join(agentDir, SETTINGS_FILE);

export const projectSettingsPath = (cwd: string) => join(cwd, ".pi", SETTINGS_FILE);

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
        host.notify(`pi-session-limits settings: ${error}`, "warning");
      });
  });

  return () => ratios;
};
