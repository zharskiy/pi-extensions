import type { SettingsSchema } from "../plugin/settings-files.ts";
import { formatTokens, formatWindow } from "../text/format.ts";

export type Limits = { softRatio: number; hardRatio: number; softTokens: number; hardTokens: number };

const ratio = { type: "number", min: 0, max: 1, minExclusive: true } as const;

const tokens = { type: "number", min: 0, max: 100_000_000, minExclusive: true } as const;

export const limitsSchema: Required<SettingsSchema<Limits>> = {
  softRatio: ratio,
  hardRatio: ratio,
  softTokens: tokens,
  hardTokens: tokens,
};

export type HandoffLimit = { request: number; warn: number };

export const mainLimit = (window: number, limits: Limits): HandoffLimit | undefined => {
  if (window <= 0) {
    return undefined;
  }

  return {
    request: Math.min(window * limits.hardRatio, limits.hardTokens),
    warn: Math.min(window * limits.softRatio, limits.softTokens),
  };
};

export type LimitLevel = "unknown" | "normal" | "soft" | "hard";

export const limitLevel = (tokens: number | null, limit: HandoffLimit | undefined): LimitLevel => {
  if (tokens === null || !limit) {
    return "unknown";
  }

  if (tokens >= limit.request) {
    return "hard";
  }

  return tokens >= limit.warn ? "soft" : "normal";
};

export const WORKING_CONTEXT = "working context";

export const workingContextText = (tokens: number, request: number) =>
  `${WORKING_CONTEXT} ${formatTokens(tokens)} of ${formatWindow(request)}`;
