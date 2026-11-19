import {
  errorText,
  loadSettingsFiles,
  type SettingsLocation,
  type SettingsSchema,
  settingsPath,
  writeSettingsFile,
} from "../../../platform/shared/index.ts";

export type PruneSettings = { days: number };

export const NAMESPACE = "pi-prune";

export const SETTINGS_FILE = `${NAMESPACE}.json`;

const MAX_DAYS = 36_500;

export const INTERVALS = [7, 30, 60, 90, 180, 365];

export const defaults: PruneSettings = { days: 180 };

export const schema: SettingsSchema<PruneSettings> = {
  days: { type: "number", min: 0, max: MAX_DAYS, integer: true },
};

export const loadDays = (location: SettingsLocation) =>
  loadSettingsFiles(schema, defaults, SETTINGS_FILE, location, "user");

export const saveDays = (location: SettingsLocation, days: number): string | undefined => {
  try {
    writeSettingsFile(location, "user", SETTINGS_FILE, `${JSON.stringify({ days }, null, 2)}\n`);
    return undefined;
  } catch (error) {
    return `cannot save ${settingsPath(location, "user", SETTINGS_FILE)}: ${errorText(error)}`;
  }
};
