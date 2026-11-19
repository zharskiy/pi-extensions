import type { SettingsSchema } from "../../../platform/shared/index.ts";

export type PruneSettings = { days: number };

export const NAMESPACE = "pi-prune";

export const SETTINGS_FILE = `${NAMESPACE}.json`;

export const MAX_DAYS = 36_500;

export const defaults: PruneSettings = { days: 180 };

export const schema: SettingsSchema<PruneSettings> = {
  days: { type: "number", min: 0, max: MAX_DAYS, integer: true },
};
