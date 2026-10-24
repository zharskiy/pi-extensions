import { noun } from "../../../core/manager/format.ts";
import { ELLIPSIS } from "../../../core/manager/layout.ts";
import type { RowRender, Styled, TitleParts } from "../../../core/manager/row.ts";
import type { ThemeLike, ToolCallView } from "../../../pi-adapter/index.ts";
import { errorRows, outputLines, wrappedRows } from "./output.ts";

export const MORE = ` ${ELLIPSIS}`;

export type Args = Record<string, unknown>;

export type Context = { view: ToolCallView; args: Args; home: string; key: string };

export type Title = Omit<TitleParts, "mark" | "verb" | "reason" | "duration">;

export type Failure = { text: string; timedOut?: boolean };

export type Outcome = { lines: string[]; hint?: boolean; body?: RowRender };

export type Look = {
  verb?: Styled;
  title(context: Context, theme: ThemeLike): Title | undefined;
  outcome(context: Context, room: number, theme: ThemeLike, reasonShown: boolean): Outcome;
  failure?(context: Context): Failure | undefined;
  piBody?(context: Context): boolean;
  dropTiming?: boolean;
  streams?: boolean;
};

export const textArg = (args: Args, ...names: string[]) =>
  names.map((name) => args[name]).find((value): value is string => typeof value === "string" && value !== "");

export const resultText = (context: Context) => context.view.result?.text ?? "";

export const counted = (count: number, word: string, theme: ThemeLike, plural?: string) =>
  `${theme.fg("text", String(count))}${theme.fg("muted", ` ${noun(count, word, plural)}`)}`;

export const bold = (text: string) => (theme: ThemeLike) => theme.bold(text);

export const firstLineFailure = (context: Context): Failure | undefined => {
  const text = resultText(context).trim();

  return text === "" ? undefined : { text };
};

export const errorOutcome = (
  context: Context,
  room: number,
  theme: ThemeLike,
  reasonShown: boolean,
): Outcome => {
  if (reasonShown) {
    return { lines: [] };
  }

  const lines = outputLines(resultText(context) || "Error");

  return {
    lines: context.view.expanded
      ? wrappedRows(lines, "error", room, theme)
      : errorRows(lines, room, context.key, theme),
  };
};

export const stopped = (view: ToolCallView) => view.aborted && !view.isPartial;

export const failed = (context: Context) =>
  context.view.isError && !context.view.isPartial && !context.view.aborted;

export const orError =
  (outcome: Look["outcome"]): Look["outcome"] =>
  (context, room, theme, reasonShown) =>
    failed(context)
      ? errorOutcome(context, room, theme, reasonShown)
      : outcome(context, room, theme, reasonShown);
