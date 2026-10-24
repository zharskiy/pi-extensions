import type { ThemeLike } from "../pi-adapter/index.ts";

export type CacheTone = "success" | "warning" | "error";

export const cacheTone = (percent: number): CacheTone => {
  if (percent >= 70) {
    return "success";
  }

  return percent >= 30 ? "warning" : "error";
};

export const cachePercentText = (theme: ThemeLike, percent: number) =>
  theme.fg(cacheTone(percent), `${Math.round(percent)}%`);
