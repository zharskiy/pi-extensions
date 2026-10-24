import type { PromptTokens, UsageTotals } from "../pi-adapter/index.ts";

export const usageTotals = (cost: number, tokens = 100): UsageTotals => ({
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: 0,
  totalTokens: tokens * 3,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

export const promptTokens = (patch: Partial<PromptTokens> = {}): PromptTokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  ...patch,
});
