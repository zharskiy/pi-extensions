import type { ThinkingLevel } from "./model.ts";

type PaintToken = "accent" | "muted" | "dim" | "text";

export type StatusToken = "success" | "warning" | "error";

type ThinkingToken = `thinking${Capitalize<ThinkingLevel>}`;

type MessageToken = "customMessageLabel" | "customMessageText" | "userMessageText";

export type ThemeToken = PaintToken | StatusToken | ThinkingToken | MessageToken;

export type BgToken = "added" | "removed" | "addedWord" | "removedWord" | "userMessage";

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
