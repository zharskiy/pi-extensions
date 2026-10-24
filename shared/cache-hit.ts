import type { PromptTokens } from "../pi-adapter/index.ts";

type PromptUsage = Pick<PromptTokens, "input" | "cacheRead" | "cacheWrite">;

export const reportedCache = (usage: PromptUsage) => usage.cacheRead > 0 || usage.cacheWrite > 0;

export const cacheHitPercent = (usage: PromptUsage): number | undefined => {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
};

export const sessionCacheHit = (usage: PromptUsage): number | undefined =>
  reportedCache(usage) ? cacheHitPercent(usage) : undefined;
