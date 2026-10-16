import type { PromptTokens, ThemeLike } from "../adapter/contract.ts";

type PromptUsage = Pick<PromptTokens, "input" | "cacheRead" | "cacheWrite">;

export type CacheTone = "success" | "warning" | "error";

export const reportedCache = (usage: PromptUsage) => usage.cacheRead > 0 || usage.cacheWrite > 0;

export const cacheHitPercent = (usage: PromptUsage): number | undefined => {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
};

export const sessionCacheHit = (usage: PromptUsage): number | undefined =>
  reportedCache(usage) ? cacheHitPercent(usage) : undefined;

export const cacheTone = (percent: number): CacheTone => {
  if (percent >= 70) {
    return "success";
  }

  return percent >= 30 ? "warning" : "error";
};

export const cachePercentText = (theme: ThemeLike, percent: number) =>
  theme.fg(cacheTone(percent), `${Math.round(percent)}%`);
