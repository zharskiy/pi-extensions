import type { ThemeLike, ThemeToken } from "../core/adapter/contract.ts";

const GLYPHS = { bullet: "●", thinking: "∴", prompt: "❯", child: "⎿" } as const;

export type RowState = "pending" | "success" | "error" | "text";

const BULLET_TOKENS: Record<RowState, ThemeToken> = {
  pending: "dim",
  success: "accent",
  error: "error",
  text: "text",
};

const bulletToken = (state: RowState) => BULLET_TOKENS[state];

export const toolState = (state: { started?: boolean; isPartial: boolean; isError: boolean }): RowState => {
  if (state.started === false || state.isPartial) {
    return "pending";
  }

  return state.isError ? "error" : "success";
};

export type Styled = string | ((theme: ThemeLike) => string);

export type RowRender = (width: number, theme: ThemeLike) => string[];

export type RowChildren = { children?: Styled[]; hint?: Styled };

export type RowSpec = RowChildren & { state: RowState; title: Styled };

export const CHILD_INDENT = "     ";

export const TITLE_INDENT = "  ";

const paint = (text: Styled, theme: ThemeLike) => (typeof text === "function" ? text(theme) : text);

const hang = (first: string, rest: string, lines: string[]) =>
  lines.map((line, index) => `${index === 0 ? first : rest}${line}`);

const fitLine = (line: string, hint: string | undefined, width: number, theme: ThemeLike) => {
  const room = hint === undefined ? 0 : width - theme.width(hint) - 1;

  if (hint === undefined || room < 1) {
    return theme.truncate(line, width);
  }

  return `${theme.truncate(line, room)} ${hint}`;
};

const withHint = (lines: string[], hint: Styled | undefined, width: number, theme: ThemeLike) => {
  const painted = hint === undefined ? undefined : paint(hint, theme);
  const last = lines.length - 1;

  return lines.map((line, index) => fitLine(line, index === last ? painted : undefined, width, theme));
};

const childLines = (children: Styled[], theme: ThemeLike) => {
  const lines = children.flatMap((child) => paint(child, theme).split("\n"));

  return hang(`  ${theme.fg("dim", GLYPHS.child)}  `, CHILD_INDENT, lines);
};

export const bullet = (state: RowState, theme: ThemeLike) => theme.fg(bulletToken(state), GLYPHS.bullet);

export const toolRow =
  (spec: RowSpec): RowRender =>
  (width, theme) => {
    const title = `${bullet(spec.state, theme)} ${paint(spec.title, theme)}`;

    return withHint([title, ...childLines(spec.children ?? [], theme)], spec.hint, width, theme);
  };

export const childRow =
  (spec: RowChildren): RowRender =>
  (width, theme) =>
    withHint(childLines(spec.children ?? [], theme), spec.hint, width, theme);

export const noun = (count: number, word: string) => (count === 1 ? word : `${word}s`);

export const expandHint = (key: string, theme: ThemeLike) => theme.fg("dim", `(${key} expand)`);
