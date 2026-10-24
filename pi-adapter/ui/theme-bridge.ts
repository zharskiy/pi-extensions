import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BgToken, ThemeLike, ThemeToken } from "../types/theme.ts";

const ESC = "\x1b";

export const textMetrics: Pick<ThemeLike, "width" | "truncate" | "wrap"> = {
  width: visibleWidth,
  truncate: (text, cols) => {
    const cut = truncateToWidth(text, cols, "...");

    return text.includes(ESC) ? cut : stripVTControlCharacters(cut);
  },
  wrap: (text, cols) => wrapTextWithAnsi(text, Math.max(1, cols)),
};

export const fitLines = (lines: string[], width: number) =>
  lines.map((line) => truncateToWidth(line, width, "..."));

export const piColor = (token: ThemeToken): Parameters<Theme["fg"]>[0] => token;

const WORD_MIX = 0.4;

const NO_BG = "\x1b[49m";

const LINE_BGS = { added: "toolSuccessBg", removed: "toolErrorBg" } as const;

const WORD_BGS = {
  addedWord: ["toolSuccessBg", "toolDiffAdded"],
  removedWord: ["toolErrorBg", "toolDiffRemoved"],
} as const;

const piBg = (theme: Theme, token: BgToken) => {
  if (token === "added" || token === "removed") {
    return LINE_BGS[token];
  }

  const [line, word] = WORD_BGS[token];

  return mixColors(theme.colors[line], theme.colors[word], WORD_MIX);
};

export const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(piColor(token), text),
  bg: (token, text) => theme.style(text, { bg: piBg(theme, token) }),
  bold: (text) => theme.bold(text),
  inverse: (text) => theme.inverse(text),
  get panels() {
    return theme.getBgAnsi("toolSuccessBg") !== NO_BG;
  },
  ...textMetrics,
});
