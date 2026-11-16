import type { Limits } from "../../../platform/shared/index.ts";

export const NAMESPACE = "pi-session-limits";

export const SETTINGS_FILE = `${NAMESPACE}.json`;

export const DEFAULT_LIMITS: Limits = {
  softRatio: 0.45,
  hardRatio: 0.6,
  softTokens: 125_000,
  hardTokens: 175_000,
};
