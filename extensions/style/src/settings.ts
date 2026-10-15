import type { SettingsSchema } from "../../../core/manager/settings.ts";

export type StyleSettings = { style: string };

export const SETTINGS_FILE = "pi-style.json";

export const NORMAL = "normal";

export const styleSchema = (names: readonly string[]): SettingsSchema<StyleSettings> => ({
  style: { type: "choice", values: names },
});
