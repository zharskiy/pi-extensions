import { isAbsolute, relative, sep } from "node:path";
import type { ThemeLike, ToolCallView, ToolRow, ToolRows } from "../../../core/adapter/contract.ts";
import { homeRelative } from "../../../core/manager/format.ts";
import { childRow, expandHint, noun, type Styled, toolRow, toolState } from "../../../shared/row.ts";
import { diffCounts } from "./diff.ts";
import { moreLine, truncatedOutput } from "./output.ts";

type Args = Record<string, unknown>;

type Context = { view: ToolCallView; args: Args; home: string; key: () => string };

type Summary = { children: Styled[]; more: boolean };

type ToolLook = {
  name: string;
  key?: string;
  title(context: Context, value: string): Styled;
  summary?(context: Context): Summary;
  piBody?: boolean;
};

const MAX_PAIRS = 3;

const MAX_VALUE = 60;

const argsOf = (view: ToolCallView): Args =>
  typeof view.args === "object" && view.args !== null ? (view.args as Args) : {};

const textArg = (args: Args, ...names: string[]) =>
  names.map((name) => args[name]).find((value): value is string => typeof value === "string" && value !== "");

export const shortPath = (path: string, cwd: string, home: string) => {
  if (cwd && isAbsolute(path) && (path === cwd || path.startsWith(`${cwd}${sep}`))) {
    return relative(cwd, path) || ".";
  }

  return homeRelative(path, home);
};

const bold = (text: string) => (theme: ThemeLike) => theme.bold(text);

const counted = (count: number, word: string, plural?: string) => (theme: ThemeLike) =>
  `${theme.bold(String(count))} ${noun(count, word, plural)}`;

const listed = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^\[.*\]$/.test(line));

const lineCount = (text: string) => truncatedOutput(text, 0).hidden;

const pathTitle = (verb: string) => (context: Context, path: string) => (theme: ThemeLike) =>
  `${verb} ${theme.bold(shortPath(path, context.view.cwd, context.home))}`;

const readRange = (args: Args) => {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  if (offset === undefined && limit === undefined) {
    return "";
  }

  const start = offset ?? 1;

  return limit === undefined ? ` (from line ${start})` : ` (lines ${start}–${start + limit - 1})`;
};

const outputLines = (text: string, keep: "head" | "tail", token: "muted" | "error"): Summary => {
  const { lines, hidden } = truncatedOutput(text, 3, keep);
  const shown = lines.map((line) => (theme: ThemeLike) => theme.fg(token, line));
  const more = hidden > 0 ? [(theme: ThemeLike) => moreLine(hidden, theme)] : [];

  if (keep === "tail") {
    return { children: [...more, ...shown], more: false };
  }

  return { children: [...shown, ...more], more: hidden > 0 };
};

const allLines = (text: string, token: "muted" | "error"): Summary => ({
  children: truncatedOutput(text, Number.MAX_SAFE_INTEGER).lines.map(
    (line) => (theme: ThemeLike) => theme.fg(token, line),
  ),
  more: false,
});

const dim = (text: string) => (theme: ThemeLike) => theme.fg("dim", text);

const shellOutput = (context: Context): Summary => {
  const text = context.view.result?.text ?? "";

  if (context.view.isPartial) {
    return text.trim() === ""
      ? { children: [dim("Running…")], more: false }
      : outputLines(text, "tail", "muted");
  }

  if (text.trim() === "") {
    return { children: [dim("(No output)")], more: false };
  }

  return context.view.expanded ? allLines(text, "muted") : outputLines(text, "head", "muted");
};

const shellTitle = (prompt: string) => (_context: Context, command: string) => (theme: ThemeLike) => {
  const [first = "", ...rest] = command.split("\n");
  const more = rest.some((line) => line.trim() !== "") ? theme.fg("dim", " …") : "";

  return `${theme.fg("dim", prompt)} ${first}${more}`;
};

const shellBody = (context: Context): Summary =>
  context.view.expanded ? { children: [], more: false } : shellOutput(context);

const readSummary = (context: Context): Summary => {
  const result = context.view.result;

  if (result && result.images > 0) {
    return { children: ["Read image"], more: false };
  }

  const count = lineCount(result?.text ?? "");

  return { children: [(theme) => `Read ${counted(count, "line")(theme)}`], more: count > 0 };
};

const editSummary = (context: Context): Summary => {
  const diff = (context.view.result?.details as { diff?: unknown } | undefined)?.diff;
  const { added, removed } = diffCounts(typeof diff === "string" ? diff : "");
  const parts = [
    ...(added > 0 ? [(theme: ThemeLike) => `Added ${counted(added, "line")(theme)}`] : []),
    ...(removed > 0
      ? [(theme: ThemeLike) => `${added > 0 ? "removed" : "Removed"} ${counted(removed, "line")(theme)}`]
      : []),
  ];

  if (parts.length === 0) {
    return { children: [], more: false };
  }

  return {
    children: [(theme) => parts.map((part) => part(theme)).join(", ")],
    more: true,
  };
};

const writeSummary = (context: Context): Summary => {
  const content = textArg(context.args, "content") ?? "";

  return { children: [(theme) => `Wrote ${counted(lineCount(content), "line")(theme)}`], more: false };
};

const foundSummary =
  (word: string, empty: RegExp, none?: string) =>
  (context: Context): Summary => {
    const text = context.view.result?.text ?? "";
    const count = empty.test(text.trim()) ? 0 : listed(text).length;

    if (count === 0 && none !== undefined) {
      return { children: [none], more: false };
    }

    return { children: [(theme) => `Found ${counted(count, word)(theme)}`], more: count > 0 };
  };

const listSummary = (context: Context): Summary => {
  const text = context.view.result?.text ?? "";
  const count = text.trim() === "(empty directory)" ? 0 : listed(text).length;

  return { children: [(theme) => `Listed ${counted(count, "entry", "entries")(theme)}`], more: count > 0 };
};

const LOOKS: Record<string, ToolLook> = {
  read: {
    name: "Read",
    key: "path",
    title: (context, path) => (theme) =>
      `${pathTitle("Read")(context, path)(theme)}${theme.fg("dim", readRange(context.args))}`,
    summary: readSummary,
    piBody: true,
  },
  edit: { name: "Update", key: "path", title: pathTitle("Update"), summary: editSummary, piBody: true },
  write: { name: "Write", key: "path", title: pathTitle("Write"), summary: writeSummary },
  bash: { name: "Bash", key: "command", title: shellTitle("$"), summary: shellBody, piBody: true },
  powershell: {
    name: "PowerShell",
    key: "command",
    title: shellTitle("PS>"),
    summary: shellBody,
    piBody: true,
  },
  grep: {
    name: "Grep",
    key: "pattern",
    title: (context, pattern) => (theme) => {
      const path = textArg(context.args, "path");
      const where = path ? ` in ${shortPath(path, context.view.cwd, context.home)}` : "";

      return `Grep ${theme.bold(pattern)}${where}`;
    },
    summary: foundSummary("line", /^No matches found/, "No matches"),
    piBody: true,
  },
  find: {
    name: "Find",
    key: "pattern",
    title: (_context, pattern) => (theme) => `Find ${theme.bold(pattern)}`,
    summary: foundSummary("file", /^No files found/),
    piBody: true,
  },
  ls: { name: "List", title: pathTitle("List"), summary: listSummary, piBody: true },
};

const valueText = (value: unknown) => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const [first = ""] = text.split("\n");
  const cut = first.length > MAX_VALUE ? first.slice(0, MAX_VALUE) : first;

  return cut === text ? text : `${cut}…`;
};

const pairs = (args: Args) =>
  Object.entries(args)
    .slice(0, MAX_PAIRS)
    .map(([name, value]) => `${name}: ${valueText(value)}`)
    .join(", ");

const genericTitle = (context: Context) => (theme: ThemeLike) => {
  const summary = pairs(context.args);

  return summary ? `${theme.bold(context.view.name)} ${summary}` : theme.bold(context.view.name);
};

const errorSummary = (context: Context): Summary => {
  const text = context.view.result?.text || "Error";

  return context.view.expanded ? allLines(text, "error") : outputLines(text, "head", "error");
};

const titleOf = (look: ToolLook | undefined, context: Context): Styled => {
  if (!look) {
    return genericTitle(context);
  }

  if (look.key === undefined) {
    const path = textArg(context.args, "path");

    return path === undefined && !context.view.argsComplete
      ? bold(look.name)
      : look.title(context, path ?? ".");
  }

  const value = textArg(context.args, look.key, ...(look.key === "path" ? ["file_path"] : []));

  return value === undefined ? bold(look.name) : look.title(context, value);
};

const summaryOf = (look: ToolLook | undefined, context: Context): Summary => {
  if (context.view.isError && !context.view.isPartial) {
    return errorSummary(context);
  }

  return (look?.summary ?? shellOutput)(context);
};

const resultRow = (look: ToolLook | undefined, context: Context) => {
  const summary = summaryOf(look, context);
  const hint =
    summary.more && !context.view.expanded
      ? (theme: ThemeLike) => expandHint(context.key(), theme)
      : undefined;

  return childRow({ children: summary.children, hint });
};

export const transcriptRows =
  (key: () => string, home: string): ToolRows =>
  (view): ToolRow => {
    const look = LOOKS[view.name];
    const context: Context = { view, args: argsOf(view), home, key };

    return {
      call: toolRow({ state: toolState(view), title: titleOf(look, context) }),
      result: view.result ? resultRow(look, context) : undefined,
      piBody: look?.piBody === true && !view.isError,
    };
  };
