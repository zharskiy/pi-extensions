import type { SettingsSchema } from "../../../core/manager/settings.ts";
import type { Ratios } from "./thresholds.ts";

export const SETTINGS_FILE = "pi-session-limits.json";

export const DEFAULT_RATIOS: Ratios = { softRatio: 0.6, hardRatio: 0.75 };

const ratio = { type: "number", min: 0, max: 1, minExclusive: true } as const;

export const schema: SettingsSchema<Ratios> = { softRatio: ratio, hardRatio: ratio };
