import { stripVTControlCharacters } from "node:util";
import type { ThemeLike, ThemeToken } from "../adapter/contract.ts";

export const EXPAND_BINDING = "app.tools.expand";

export type Styled = string | ((theme: ThemeLike) => string);

export type RowRender = (width: number, theme: ThemeLike) => string[];

const paint = (text: Styled, theme: ThemeLike) => (typeof text === "function" ? text(theme) : text);

export const noun = (count: number, word: string, plural = `${word}s`) => (count === 1 ? word : plural);

export const rowText = (render: RowRender, theme: ThemeLike) => (width: number) =>
  render(width, theme).join("\n");

export const MARKS = {
  pending: "◌",
  success: "✓",
  error: "✗",
  stopped: "⊘",
  info: "»",
  child: "↳",
  pointer: "›",
} as const;

export type Mark = "pending" | "success" | "error" | "stopped" | "info";

export const MARK_TOKENS: Record<Mark, ThemeToken> = {
  pending: "dim",
  success: "success",
  error: "error",
  stopped: "muted",
  info: "accent",
};

export const markGlyph = (mark: Mark, theme: ThemeLike) => theme.fg(MARK_TOKENS[mark], MARKS[mark]);

export const markOf = (view: {
  started?: boolean;
  isPartial: boolean;
  isError: boolean;
  aborted?: boolean;
}): Mark => {
  if (view.started === false || view.isPartial) {
    return "pending";
  }

  if (view.aborted) {
    return "stopped";
  }

  return view.isError ? "error" : "success";
};

export const TITLE_COLUMN = 2;

export const CHILD_COLUMN = 4;

export const NEST = 4;

export const ELLIPSIS = "...";

const MIN_TARGET = 8;

const MIN_SUMMARY = 20;

const MAX_REASON = 32;

const graphemes = new Intl.Segmenter();

export const cutStart = (text: string, cols: number, theme: ThemeLike) => {
  if (theme.width(text) <= cols) {
    return text;
  }

  if (cols <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, Math.max(0, cols));
  }

  const room = cols - ELLIPSIS.length;
  const parts = Array.from(graphemes.segment(text), ({ segment }) => segment).reverse();
  const used = parts.map((part) => theme.width(part));
  const ends = used.map((_, index) => used.slice(0, index + 1).reduce((sum, width) => sum + width, 0));
  const count = ends.filter((end) => end <= room).length;

  return `${ELLIPSIS}${parts.slice(0, count).reverse().join("")}`;
};

const isBlankLine = (line: string) => stripVTControlCharacters(line).trim() === "";

const fitTo = (line: string, width: number, theme: ThemeLike) =>
  isBlankLine(line) ? "" : theme.truncate(line, Math.max(0, width));

export const expandHint = (key: string): Styled | undefined =>
  key === "" ? undefined : (theme) => theme.fg("dim", `(${key} to expand)`);

export const appendHint = (
  line: string,
  hint: string | undefined,
  width: number,
  theme: ThemeLike,
  options: { cuttable?: boolean } = {},
) => {
  if (hint === undefined) {
    return theme.truncate(line, width);
  }

  const room = width - 1 - theme.width(hint);

  if (theme.width(line) <= room) {
    return `${line} ${hint}`;
  }

  if (options.cuttable && theme.width(line) > width && room >= MIN_SUMMARY) {
    return `${theme.truncate(line, room)} ${hint}`;
  }

  return theme.truncate(line, width);
};

export type CountSpec = {
  hidden: number;
  end: "more" | "earlier";
  noun: "line" | "item";
  key?: string;
};

export const countLine = (spec: CountSpec, width: number, theme: ThemeLike) => {
  const count = `${spec.hidden} ${spec.end} ${noun(spec.hidden, spec.noun)}`;
  const keyed = spec.key ? `${ELLIPSIS} (${count}, ${spec.key} to expand)` : undefined;

  if (spec.key && keyed !== undefined && theme.width(keyed) <= width) {
    return [
      theme.fg("muted", `${ELLIPSIS} (${count}, `),
      theme.fg("dim", spec.key),
      theme.fg("muted", " to expand)"),
    ].join("");
  }

  return theme.truncate(theme.fg("muted", `${ELLIPSIS} (${count})`), width);
};

export const wrapChild = (text: string, width: number, column: number, theme: ThemeLike) =>
  text.split("\n").flatMap((line) => theme.wrap(line, Math.max(1, width - column)));

export const preview = (lines: readonly string[], options: { keep: "head" | "tail"; max?: number }) => {
  const max = options.max ?? 3;
  const hidden = Math.max(0, lines.length - max);
  const shown = options.keep === "head" ? lines.slice(0, max) : lines.slice(hidden);

  return { shown, hidden };
};

export type TitleTarget = {
  text: string;
  token?: ThemeToken;
  bold?: boolean;
  cut?: "start" | "end";
  tail?: string;
};

export type TitleParts = {
  mark: Mark;
  verb?: Styled;
  target?: TitleTarget;
  args?: string;
  reason?: { text: string; token?: ThemeToken };
  duration?: string;
  hint?: Styled;
};

const SEP = " · ";

const segment = (text: string | undefined, theme: ThemeLike, token: ThemeToken = "muted") =>
  text === undefined ? "" : `${theme.fg("muted", SEP)}${theme.fg(token, text)}`;

const fixedWidth = (parts: TitleParts, theme: ThemeLike) => {
  const verb = parts.verb === undefined ? 0 : theme.width(paint(parts.verb, theme));
  const gap = parts.verb !== undefined && (parts.target || parts.args) ? 1 : 0;
  const reason = parts.reason ? theme.width(`${SEP}${parts.reason.text}`) : 0;

  return TITLE_COLUMN + verb + gap + reason;
};

const targetWidth = (target: TitleTarget | undefined, theme: ThemeLike) =>
  target ? theme.width(target.text) + theme.width(target.tail ?? "") : 0;

const argsWidth = (parts: TitleParts, theme: ThemeLike) =>
  parts.args ? theme.width(parts.args) + (parts.target ? 1 : 0) : 0;

const paintTarget = (target: TitleTarget, room: number, theme: ThemeLike) => {
  const tail = target.tail ?? "";
  const whole = theme.width(target.text) + theme.width(tail);
  const style = (text: string) => {
    const colored = theme.fg(target.token ?? "accent", text);

    return target.bold ? theme.bold(colored) : colored;
  };

  if (whole <= room) {
    return `${style(target.text)}${tail ? theme.fg("muted", tail) : ""}`;
  }

  if (target.cut === "start") {
    const kept = Math.max(0, room - theme.width(tail));

    return `${style(cutStart(target.text, kept, theme))}${tail ? theme.fg("muted", tail) : ""}`;
  }

  return style(theme.truncate(target.text, Math.max(0, room)));
};

const placeTarget = (parts: TitleParts, room: number, theme: ThemeLike) => {
  const target = parts.target;
  const own = targetWidth(target, theme);
  const args = parts.args;
  const argsRoom = room - own - (target ? 1 : 0);
  const shownArgs =
    args === undefined || argsRoom <= ELLIPSIS.length
      ? ""
      : `${target ? " " : ""}${theme.fg("muted", theme.truncate(args, argsRoom))}`;
  const painted = target ? paintTarget(target, room, theme) : "";

  return `${painted}${shownArgs}`;
};

export const titleLine = (parts: TitleParts, width: number, theme: ThemeLike) => {
  const room = width - fixedWidth(parts, theme);
  const full = targetWidth(parts.target, theme) + argsWidth(parts, theme);
  const duration = segment(parts.duration, theme);
  const hint = parts.hint === undefined ? "" : ` ${paint(parts.hint, theme)}`;
  const keepDuration = full + theme.width(duration) <= room;
  const keepHint = keepDuration && full + theme.width(duration) + theme.width(hint) <= room;
  const left = room - (keepDuration ? theme.width(duration) : 0) - (keepHint ? theme.width(hint) : 0);
  const verb = parts.verb === undefined ? "" : paint(parts.verb, theme);
  const gap = verb && (parts.target || parts.args) ? " " : "";
  const line = [
    `${markGlyph(parts.mark, theme)} `,
    verb,
    gap,
    placeTarget(parts, left, theme),
    segment(parts.reason?.text, theme, parts.reason?.token ?? "error"),
    keepDuration ? duration : "",
    keepHint ? hint : "",
  ].join("");

  return theme.truncate(line, width);
};

export const failureSuffix = (reason: string, parts: TitleParts, width: number, theme: ThemeLike) => {
  const text = reason.trim();

  if (text === "" || text.includes("\n") || theme.width(text) > MAX_REASON) {
    return undefined;
  }

  const target = Math.min(MIN_TARGET, targetWidth(parts.target, theme) + argsWidth(parts, theme));
  const needed = fixedWidth({ ...parts, reason: { text } }, theme) + target;

  return needed <= width ? text : undefined;
};

export type RowChild = Styled | MarkedRow;

export type MarkedRow = {
  mark: Mark;
  title: Styled | Omit<TitleParts, "mark">;
  children?: RowChild[];
  hint?: Styled;
  hintCuts?: boolean;
  body?: RowRender;
};

type Placed = { prefix: string; text: string; summary: boolean };

const isRow = (child: RowChild): child is MarkedRow => typeof child === "object";

const isParts = (title: MarkedRow["title"]): title is Omit<TitleParts, "mark"> => typeof title === "object";

const joined = ({ prefix, text }: Placed) => (isBlankLine(text) ? "" : `${prefix}${text}`);

const childArea = (children: RowChild[], width: number, theme: ThemeLike): Placed[] => {
  const lead = `  ${theme.fg("dim", MARKS.child)} `;
  const indent = " ".repeat(CHILD_COLUMN);
  const lines = children.flatMap((child) =>
    isRow(child)
      ? markedRow(child, width - NEST, theme).map((text) => ({ text, summary: false }))
      : paint(child, theme)
          .split("\n")
          .map((text) => ({ text, summary: true })),
  );

  return lines.map((line, index) => ({ ...line, prefix: index === 0 ? lead : indent }));
};

const titleArea = (spec: MarkedRow, width: number, theme: ThemeLike): Placed[] => {
  if (isParts(spec.title)) {
    return [
      { prefix: "", text: titleLine({ ...spec.title, mark: spec.mark }, width, theme), summary: false },
    ];
  }

  const [first = "", ...rest] = paint(spec.title, theme).split("\n");
  const indent = " ".repeat(TITLE_COLUMN);

  return [
    { prefix: `${markGlyph(spec.mark, theme)} `, text: first, summary: false },
    ...rest.map((text) => ({ prefix: indent, text, summary: false })),
  ];
};

const hinted = (
  placed: Placed[],
  spec: Pick<MarkedRow, "hint" | "hintCuts">,
  width: number,
  theme: ThemeLike,
) => {
  const last = placed.at(-1);

  if (spec.hint === undefined || last === undefined) {
    return placed.map(joined);
  }

  const room = width - theme.width(last.prefix);
  const text = appendHint(last.text, paint(spec.hint, theme), room, theme, {
    cuttable: spec.hintCuts === true && last.summary,
  });

  return [...placed.slice(0, -1).map(joined), joined({ ...last, text })];
};

const bodyArea = (body: RowRender | undefined, width: number, theme: ThemeLike) => {
  const indent = " ".repeat(CHILD_COLUMN);

  return body
    ? body(Math.max(1, width - CHILD_COLUMN), theme).map((text) =>
        joined({ prefix: indent, text, summary: false }),
      )
    : [];
};

const markedRow = (spec: MarkedRow, width: number, theme: ThemeLike): string[] => {
  const own = [...titleArea(spec, width, theme), ...childArea(spec.children ?? [], width, theme)];

  return [...hinted(own, spec, width, theme), ...bodyArea(spec.body, width, theme)].map((line) =>
    fitTo(line, width, theme),
  );
};

export const row =
  (spec: MarkedRow): RowRender =>
  (width, theme) =>
    markedRow(spec, width, theme);

export const rowChildren =
  (spec: Omit<MarkedRow, "mark" | "title">): RowRender =>
  (width, theme) => {
    const own = childArea(spec.children ?? [], width, theme);

    return [...hinted(own, spec, width, theme), ...bodyArea(spec.body, width, theme)].map((line) =>
      fitTo(line, width, theme),
    );
  };
