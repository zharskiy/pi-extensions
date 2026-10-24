import { type ThemeLike, type ThemeToken, textMetrics } from "../pi-adapter/index.ts";

export const plainTheme: ThemeLike = {
  fg: (_token, text) => text,
  bg: (_token, text) => text,
  bold: (text) => text,
  inverse: (text) => text,
  panels: true,
  ...textMetrics,
};

type TaggingOptions = { close?: (token: ThemeToken) => string; bold?: boolean };

const boldTag = (text: string) => `<b>${text}</b>`;

export const tokenTaggingTheme = ({ close = () => "</>", bold = false }: TaggingOptions = {}): ThemeLike => ({
  ...plainTheme,
  fg: (token, text) => `<${token}>${text}${close(token)}`,
  bold: bold ? boldTag : plainTheme.bold,
});

export const paintRecordingTheme = () => {
  const painted: { token: ThemeToken; text: string }[] = [];
  const bolded: string[] = [];
  const theme: ThemeLike = {
    ...plainTheme,
    fg: (token, text) => {
      painted.push({ token, text });
      return text;
    },
    bold: (text) => {
      bolded.push(text);
      return text;
    },
  };

  return { theme, painted, bolded };
};
