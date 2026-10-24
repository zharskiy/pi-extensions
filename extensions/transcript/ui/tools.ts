import {
  CHILD_COLUMN,
  type ThemeLike,
  type ToolCallView,
  type ToolRow,
  type ToolRows,
} from "../../../platform/pi-adapter/index.ts";
import { shortPath } from "../../../platform/shared/index.ts";
import {
  expandHint,
  failureSuffix,
  markOf,
  type RowRender,
  row,
  rowChildren,
  type TitleParts,
} from "../../../platform/ui-kit/index.ts";
import { argsOf, diffText, isMissingFile, listedCount, readRange, slowDuration } from "../core/tool-kinds.ts";
import { codemodeLook } from "./codemode.ts";
import { type DiffLine, diffCounts, diffRows, parseDiff } from "./diff.ts";
import { genericLook } from "./generic.ts";
import { outputLines } from "./output.ts";
import { shellLook } from "./shell.ts";
import {
  bold,
  type Context,
  counted,
  type Failure,
  failed,
  firstLineFailure,
  type Look,
  type Outcome,
  orError,
  resultText,
  stopped,
  type Title,
  textArg,
} from "./tool-look.ts";

const pathOf = (context: Context) => textArg(context.args, "path", "file_path");

const pathTitle =
  (tail?: (context: Context) => string) =>
  (context: Context): Title | undefined => {
    const path = pathOf(context);

    if (path === undefined) {
      return undefined;
    }

    const extra = tail?.(context) ?? "";

    return {
      target: {
        text: shortPath(path, context.view.cwd, context.home),
        cut: "start",
        ...(extra === "" ? {} : { tail: extra }),
      },
    };
  };

const fileFailure = (context: Context): Failure | undefined =>
  isMissingFile(resultText(context)) ? { text: "file not found" } : firstLineFailure(context);

const summaryOnly = (line: (context: Context, theme: ThemeLike) => string) => ({
  outcome: orError((context, _room, theme) => ({ lines: [line(context, theme)] })),
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
  const diff = diffText(context.view);

  return diff === undefined ? undefined : parseDiff(diff);
};

const changeLine = (added: number, removed: number, theme: ThemeLike) =>
  [
    ...(added > 0 ? [`${theme.fg("muted", "Added ")}${counted(added, "line", theme)}`] : []),
    ...(removed > 0
      ? [`${theme.fg("muted", added > 0 ? "removed " : "Removed ")}${counted(removed, "line", theme)}`]
      : []),
  ].join(theme.fg("muted", ", "));

const editOutcome = orError((context, _room, theme): Outcome => {
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
});

const writeOutcome = orError((context, _room, theme): Outcome => {
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
});

const found =
  (word: string, empty: RegExp, none: string, plural?: string) => (context: Context, theme: ThemeLike) => {
    const text = resultText(context);
    const count = listedCount(text, empty);

    return count === 0 ? theme.fg("muted", none) : counted(count, word, theme, plural);
  };

const grepTitle = (context: Context, theme: ThemeLike): Title | undefined => {
  const pattern = textArg(context.args, "pattern");

  if (pattern === undefined) {
    return undefined;
  }

  const path = textArg(context.args, "path");
  const where = path ? ` in ${theme.fg("accent", shortPath(path, context.view.cwd, context.home))}` : "";

  return { target: { text: pattern, cut: "end", ...(where ? { tail: where } : {}) } };
};

const findTitle = (context: Context): Title | undefined => {
  const pattern = textArg(context.args, "pattern");

  return pattern === undefined ? undefined : { target: { text: pattern, cut: "end" } };
};

const listTitle = (context: Context): Title | undefined => {
  const path = pathOf(context) ?? (context.view.argsComplete ? "." : undefined);

  return path === undefined
    ? undefined
    : { target: { text: shortPath(path, context.view.cwd, context.home), cut: "start" } };
};

const LOOKS: Record<string, Look> = {
  read: {
    verb: bold("read"),
    title: pathTitle((context) => readRange(context.args)),
    failure: fileFailure,
    ...summaryOnly(readLine),
  },
  edit: {
    verb: bold("edit"),
    title: pathTitle(),
    outcome: editOutcome,
    piBody: (context) => !failed(context) && editDiff(context) === undefined,
  },
  write: { verb: bold("write"), title: pathTitle(), outcome: writeOutcome, failure: fileFailure },
  bash: shellLook("bash"),
  powershell: shellLook("powershell"),
  grep: {
    verb: bold("grep"),
    title: grepTitle,
    ...summaryOnly(found("matching line", /^No matches found/, "No matches")),
  },
  find: {
    verb: bold("find"),
    title: findTitle,
    ...summaryOnly(found("file", /^No files found/, "No files")),
  },
  ls: {
    verb: bold("ls"),
    title: listTitle,
    ...summaryOnly(found("entry", /^\(empty directory\)$/, "Empty directory", "entries")),
  },
  codemode: codemodeLook,
};

const lookFor = (view: ToolCallView) => LOOKS[view.name] ?? genericLook(view.name, view.label);

type Heading = { parts: TitleParts; reasonShown: boolean };

const heading = (look: Look, context: Context, width: number, theme: ThemeLike): Heading => {
  const view = context.view;
  const mark = markOf(view);
  const base: TitleParts = { mark, verb: look.verb, ...look.title(context, theme) };
  const failure = failed(context) && view.result ? (look.failure ?? firstLineFailure)(context) : undefined;
  const duration = slowDuration(view, failure?.timedOut);
  const timed = duration === undefined ? base : { ...base, duration };

  if (stopped(view)) {
    return { parts: { ...timed, reason: { text: "stopped", token: "muted" } }, reasonShown: true };
  }

  const reason = failure ? failureSuffix(failure.text, timed, width, theme) : undefined;

  return reason === undefined
    ? { parts: timed, reasonShown: false }
    : { parts: { ...timed, reason: { text: reason } }, reasonShown: true };
};

const resultRows = (look: Look, context: Context) => (width: number, theme: ThemeLike) => {
  if (stopped(context.view) && !look.streams) {
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
