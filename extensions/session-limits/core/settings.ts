import type { Limits, SettingsSchema } from "../../../platform/shared/index.ts";

export const SETTINGS_FILE = "pi-session-limits.json";

export const DEFAULT_LIMITS: Limits = {
  softRatio: 0.45,
  hardRatio: 0.6,
  softTokens: 125_000,
  hardTokens: 175_000,
};

const ratio = { type: "number", min: 0, max: 1, minExclusive: true } as const;

const tokens = { type: "number", min: 0, max: 100_000_000, minExclusive: true } as const;

export const schema: SettingsSchema<Limits> = {
  softRatio: ratio,
  hardRatio: ratio,
  softTokens: tokens,
  hardTokens: tokens,
};
