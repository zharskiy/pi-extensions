import type { ThinkingLevel } from "./model.ts";

export type PaintToken = "accent" | "muted" | "dim" | "text";

export type StatusToken = "success" | "warning" | "error";

export type ThinkingToken = `thinking${Capitalize<ThinkingLevel>}`;

export type MessageToken = "customMessageLabel" | "customMessageText";

export type ThemeToken = PaintToken | StatusToken | ThinkingToken | MessageToken;

export type BgToken = "added" | "removed" | "addedWord" | "removedWord";

export type ThemeLike = {
  fg(token: ThemeToken, text: string): string;
  bg(token: BgToken, text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
  readonly panels: boolean;
  width(text: string): number;
  truncate(text: string, cols: number): string;
  wrap(text: string, cols: number): string[];
};
