import type { ThemeLike, ToolCallView, ToolRow, ToolRows } from "../../../core/adapter/contract.ts";
import { formatDuration, shortPath } from "../../../core/manager/format.ts";
import { expandHint } from "../../../core/manager/hints.ts";
import { markOf } from "../../../core/manager/marks.ts";
import {
  CHILD_COLUMN,
  failureSuffix,
  type RowRender,
  row,
  rowChildren,
  type TitleParts,
} from "../../../core/manager/row.ts";
import { codemodeLook } from "./codemode.ts";
import { type DiffLine, diffCounts, diffRows, parseDiff } from "./diff.ts";
import { genericLook } from "./generic.ts";
import {
  type Args,
  bold,
  type Context,
  counted,
  errorOutcome,
  type Failure,
  failed,
  firstLineFailure,
  type Look,
  type Outcome,
  resultText,
  type Title,
  textArg,
} from "./look.ts";
import { outputLines } from "./output.ts";
import { shellLook } from "./shell.ts";

const SLOW_MS = 5000;

const argsOf = (view: ToolCallView): Args =>
  typeof view.args === "object" && view.args !== null ? (view.args as Args) : {};

const listed = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^\[.*\]$/.test(line));

const numberArg = (value: unknown) => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};

const readRange = (args: Args) => {
  const offset = numberArg(args.offset);
  const limit = numberArg(args.limit);

  if (offset === undefined && limit === undefined) {
    return "";
  }

  const start = offset ?? 1;

  return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
};

const pathOf = (context: Context) => textArg(context.args, "path", "file_path");

const pathTitle =
  (verb: string, tail?: (context: Context) => string) =>
  (context: Context): Title | undefined => {
    const path = pathOf(context);

    if (path === undefined) {
      return undefined;
    }

    const extra = tail?.(context) ?? "";

    return {
      verb: bold(verb),
      target: {
        text: shortPath(path, context.view.cwd, context.home),
        cut: "start",
        ...(extra === "" ? {} : { tail: extra }),
      },
    };
  };

const ENOENT = /ENOENT|no such file or directory/i;

const fileFailure = (context: Context): Failure | undefined =>
  ENOENT.test(resultText(context)) ? { text: "file not found" } : firstLineFailure(context);

const summaryOnly = (line: (context: Context, theme: ThemeLike) => string) => ({
  outcome: (context: Context, room: number, theme: ThemeLike, reasonShown: boolean): Outcome =>
    failed(context) ? errorOutcome(context, room, theme, reasonShown) : { lines: [line(context, theme)] },
  piBody: (context: Context) => !failed(context),
});

const readLine = (context: Context, theme: ThemeLike) => {
  if ((context.view.result?.images ?? 0) > 0) {
    return theme.fg("muted", "Image");
  }

  return counted(outputLines(resultText(context)).length, "line", theme);
};

const diffBody =
  (lines: DiffLine[]): RowRender =>
  (width, theme) =>
    diffRows(lines, width, theme);

const editDiff = (context: Context) => {
  const diff = (context.view.result?.details as { diff?: unknown } | undefined)?.diff;

  return typeof diff === "string" ? parseDiff(diff) : undefined;
};

const changeLine = (added: number, removed: number, theme: ThemeLike) =>
  [
    ...(added > 0 ? [`${theme.fg("muted", "Added ")}${counted(added, "line", theme)}`] : []),
    ...(removed > 0
      ? [`${theme.fg("muted", added > 0 ? "removed " : "Removed ")}${counted(removed, "line", theme)}`]
      : []),
  ].join(theme.fg("muted", ", "));

const editOutcome = (context: Context, room: number, theme: ThemeLike, reasonShown: boolean): Outcome => {
  if (failed(context)) {
    return errorOutcome(context, room, theme, reasonShown);
  }

  const lines = editDiff(context);

  if (lines === undefined) {
    return { lines: [] };
  }

  const { added, removed } = diffCounts(lines);
  const summary = added + removed > 0 ? [changeLine(added, removed, theme)] : [];

  return {
    lines: summary,
    hint: summary.length > 0,
    body: context.view.expanded ? diffBody(lines) : undefined,
  };
};

const writeOutcome = (context: Context, room: number, theme: ThemeLike, reasonShown: boolean): Outcome => {
  if (failed(context)) {
    return errorOutcome(context, room, theme, reasonShown);
  }

  const content = outputLines(textArg(context.args, "content") ?? "");

  if (content.length === 0) {
    return { lines: [theme.fg("muted", "Empty file")] };
  }

  const rows = content.map((text, index): DiffLine => ({ kind: "added", num: String(index + 1), text }));

  return {
    lines: [counted(content.length, "line", theme)],
    hint: true,
    body: context.view.expanded ? diffBody(rows) : undefined,
  };
};

const found =
  (word: string, empty: RegExp, none: string, plural?: string) => (context: Context, theme: ThemeLike) => {
    const text = resultText(context);
    const count = empty.test(text.trim()) ? 0 : listed(text).length;

    return count === 0 ? theme.fg("muted", none) : counted(count, word, theme, plural);
  };

const grepTitle = (context: Context, theme: ThemeLike): Title | undefined => {
  const pattern = textArg(context.args, "pattern");

  if (pattern === undefined) {
    return undefined;
  }

  const path = textArg(context.args, "path");
  const where = path ? ` in ${theme.fg("accent", shortPath(path, context.view.cwd, context.home))}` : "";

  return { verb: bold("Grep"), target: { text: pattern, cut: "end", ...(where ? { tail: where } : {}) } };
};

const findTitle = (context: Context): Title | undefined => {
  const pattern = textArg(context.args, "pattern");

  return pattern === undefined ? undefined : { verb: bold("Find"), target: { text: pattern, cut: "end" } };
};

const listTitle = (context: Context): Title | undefined => {
  const path = pathOf(context) ?? (context.view.argsComplete ? "." : undefined);

  return path === undefined
    ? undefined
    : { verb: bold("List"), target: { text: shortPath(path, context.view.cwd, context.home), cut: "start" } };
};

const LOOKS: Record<string, Look> = {
  read: {
    verb: bold("Read"),
    title: pathTitle("Read", (context) => readRange(context.args)),
    failure: fileFailure,
    ...summaryOnly(readLine),
  },
  edit: {
    verb: bold("Edit"),
    title: pathTitle("Edit"),
    outcome: editOutcome,
    piBody: (context) => !failed(context) && editDiff(context) === undefined,
  },
  write: { verb: bold("Write"), title: pathTitle("Write"), outcome: writeOutcome, failure: fileFailure },
  bash: shellLook("$"),
  powershell: shellLook("PS>"),
  grep: {
    verb: bold("Grep"),
    title: grepTitle,
    ...summaryOnly(found("matching line", /^No matches found/, "No matches")),
  },
  find: {
    verb: bold("Find"),
    title: findTitle,
    ...summaryOnly(found("file", /^No files found/, "No files")),
  },
  ls: {
    verb: bold("List"),
    title: listTitle,
    ...summaryOnly(found("entry", /^\(empty directory\)$/, "Empty directory", "entries")),
  },
  codemode: codemodeLook,
};

const lookFor = (view: ToolCallView) => LOOKS[view.name] ?? genericLook(view.name, view.label);

type Heading = { parts: TitleParts; reasonShown: boolean };

const durationOf = (view: ToolCallView, failure: Failure | undefined) => {
  if (view.isPartial || view.result === undefined || failure?.timedOut) {
    return undefined;
  }

  return view.durationMs !== undefined && view.durationMs >= SLOW_MS
    ? formatDuration(view.durationMs)
    : undefined;
};

const heading = (look: Look, context: Context, width: number, theme: ThemeLike): Heading => {
  const view = context.view;
  const mark = markOf(view);
  const base: TitleParts = { mark, ...(look.title(context, theme) ?? { verb: look.verb }) };
  const failure = failed(context) && view.result ? (look.failure ?? firstLineFailure)(context) : undefined;
  const duration = durationOf(view, failure);
  const timed = duration === undefined ? base : { ...base, duration };

  if (view.aborted && !view.isPartial) {
    return { parts: { ...timed, reason: { text: "stopped", token: "muted" } }, reasonShown: true };
  }

  const reason = failure ? failureSuffix(failure.text, timed, width, theme) : undefined;

  return reason === undefined
    ? { parts: timed, reasonShown: false }
    : { parts: { ...timed, reason: { text: reason } }, reasonShown: true };
};

const resultRows = (look: Look, context: Context) => (width: number, theme: ThemeLike) => {
  if (context.view.aborted && !context.view.isPartial && !look.streams) {
    return [];
  }

  const { reasonShown } = heading(look, context, width, theme);
  const outcome = look.outcome(context, width - CHILD_COLUMN, theme, reasonShown);
  const hint = outcome.hint && !context.view.expanded ? expandHint(context.key) : undefined;

  return rowChildren({ children: outcome.lines, hint, hintCuts: true, body: outcome.body })(width, theme);
};

export const transcriptRows =
  (key: () => string, home: string): ToolRows =>
  (view): ToolRow => {
    const look = lookFor(view);
    const context: Context = { view, args: argsOf(view), home, key: key() };

    return {
      call: (width, theme) => {
        const { parts } = heading(look, context, width, theme);
        const { mark, ...title } = parts;

        return row({ mark, title })(width, theme);
      },
      result: view.result ? resultRows(look, context) : undefined,
      piBody: look.piBody?.(context) === true && !(view.aborted && !look.streams),
      ...(look.dropTiming ? { dropTiming: true } : {}),
    };
  };
