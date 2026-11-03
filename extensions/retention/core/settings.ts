import type { SettingsSchema } from "../../../platform/shared/index.ts";

export type RetentionSettings = { retentionDays: number };

export const SETTINGS_FILE = "pi-retention.json";

export const defaults: RetentionSettings = { retentionDays: 60 };

export const schema: SettingsSchema<RetentionSettings> = {
  retentionDays: { type: "number", min: 0, max: 36_500 },
};
