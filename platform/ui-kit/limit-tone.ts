import type { StatusToken, ThemeLike } from "../pi-adapter/index.ts";
import { DOT, formatTokens, formatWindow, type LimitLevel } from "../shared/index.ts";
import { MARKS } from "./glyphs.ts";

export const limitTone = (level: LimitLevel | undefined): StatusToken | undefined => {
  if (level === "hard") {
    return "error";
  }

  return level === "soft" ? "warning" : undefined;
};

export const limitFigure = (theme: ThemeLike, level: LimitLevel | undefined, text: string) => {
  const tone = limitTone(level);
  const painted = theme.fg(tone ?? "text", text);

  return tone === "error" ? theme.bold(painted) : painted;
};

export const limitTail = (theme: ThemeLike, level: LimitLevel | undefined, request: number) =>
  theme.fg(limitTone(level) ?? "dim", `of ${formatWindow(request)}`);

export const showsHandoffNotice = (level: LimitLevel) => level === "soft" || level === "hard";

export const handoffNotice = (tokens: number, request: number) => ({
  token: "warning" as const,
  text: `${MARKS.info} handoff at ${formatWindow(request)} tokens${DOT}${formatTokens(tokens)} used`,
});
