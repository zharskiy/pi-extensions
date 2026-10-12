import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

export type RawUsage = Parameters<typeof calculateContextTokens>[0];

export const estimateTextTokens = (text: string) =>
  estimateTokens({ role: "user", content: text, timestamp: 0 });

export const contextTokensOf = (usage: RawUsage) => calculateContextTokens(usage);
