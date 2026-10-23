import type { ThemeLike, ThemeToken } from "../adapter/contract.ts";

export const GLYPHS = { bullet: "●", thinking: "∴", chevron: "❯", child: "⎿" } as const;

export const CHILD_COLUMNS = 5;

export const EXPAND_BINDING = "app.tools.expand";

export type RowState = "pending" | "success" | "error" | "text";

const BULLET_TOKENS: Record<RowState, ThemeToken> = {
  pending: "dim",
  success: "success",
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

export type RowChildren = { children?: Styled[]; hint?: Styled; body?: RowRender };

export type RowSpec = RowChildren & { state: RowState; title: Styled };

export const CHILD_INDENT = " ".repeat(CHILD_COLUMNS);

export const TITLE_INDENT = "  ";

const paint = (text: Styled, theme: ThemeLike) => (typeof text === "function" ? text(theme) : text);

const hang = (first: string, rest: string, lines: string[]) =>
  lines.map((line, index) => `${index === 0 ? first : rest}${line}`);

const fitLine = (line: string, hint: string | undefined, width: number, theme: ThemeLike) => {
  if (hint === undefined || theme.width(line) + 1 + theme.width(hint) > width) {
    return theme.truncate(line, width);
  }

  return `${line} ${hint}`;
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

const bodyLines = (body: RowRender | undefined, width: number, theme: ThemeLike) =>
  body ? body(Math.max(1, width - CHILD_COLUMNS), theme).map((line) => `${CHILD_INDENT}${line}`) : [];

export const bullet = (state: RowState, theme: ThemeLike) => theme.fg(bulletToken(state), GLYPHS.bullet);

export const toolRow =
  (spec: RowSpec): RowRender =>
  (width, theme) => {
    const title = `${bullet(spec.state, theme)} ${paint(spec.title, theme)}`;

    return [
      ...withHint([title, ...childLines(spec.children ?? [], theme)], spec.hint, width, theme),
      ...bodyLines(spec.body, width, theme),
    ];
  };

export const childRow =
  (spec: RowChildren): RowRender =>
  (width, theme) => [
    ...withHint(childLines(spec.children ?? [], theme), spec.hint, width, theme),
    ...bodyLines(spec.body, width, theme),
  ];

export const noun = (count: number, word: string, plural = `${word}s`) => (count === 1 ? word : plural);

export const expandHint = (key: string, theme: ThemeLike) => theme.fg("dim", `(${key} expand)`);

export const rowText = (render: RowRender, theme: ThemeLike) => (width: number) =>
  render(width, theme).join("\n");
