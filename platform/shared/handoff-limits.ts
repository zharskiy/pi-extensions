export type Limits = { softRatio: number; hardRatio: number; softTokens: number; hardTokens: number };

export const thresholdsFor = (window: number, limits: Limits) => ({
  soft: Math.min(window * limits.softRatio, limits.softTokens),
  hard: Math.min(window * limits.hardRatio, limits.hardTokens),
});
