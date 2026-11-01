import type { StatusToken, ThemeLike } from "../pi-adapter/index.ts";
import { DOT, formatTokens, formatWindow, type LimitLevel, WORKING_CONTEXT } from "../shared/index.ts";
import { MARKS } from "./glyphs.ts";

const limitTone = (level: LimitLevel | undefined): StatusToken | undefined => {
  if (level === "hard") {
    return "error";
  }

  return level === "soft" ? "warning" : undefined;
};

export const limitFigure = (theme: ThemeLike, level: LimitLevel | undefined, tokens: number) => {
  const tone = limitTone(level);
  const painted = theme.fg(tone ?? "text", formatTokens(tokens));

  return tone === "error" ? theme.bold(painted) : painted;
};

export const limitTail = (theme: ThemeLike, level: LimitLevel | undefined, request: number) =>
  theme.fg(limitTone(level) ?? "dim", `of ${formatWindow(request)}`);

export const limitLine = (theme: ThemeLike, level: LimitLevel | undefined, tokens: number, request: number) =>
  `${theme.fg("dim", WORKING_CONTEXT)} ${limitFigure(theme, level, tokens)} ${limitTail(theme, level, request)}`;

export const handoffNotice = (level: LimitLevel | undefined, tokens: number, request: number) =>
  level === "soft" || level === "hard"
    ? {
        token: "warning" as const,
        text: `${MARKS.info} handoff at ${formatWindow(request)} tokens${DOT}${formatTokens(tokens)} used`,
      }
    : undefined;
