import type { SettingsSchema } from "../../../platform/shared/index.ts";

export type RetentionSettings = { retentionDays: number };

export const NAMESPACE = "pi-retention";

export const SETTINGS_FILE = `${NAMESPACE}.json`;

export const defaults: RetentionSettings = { retentionDays: 180 };

export const schema: SettingsSchema<RetentionSettings> = {
  retentionDays: { type: "number", min: 0, max: 36_500, integer: true },
};
