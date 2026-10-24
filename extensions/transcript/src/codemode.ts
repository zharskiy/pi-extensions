import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { DOT } from "../../../core/manager/layout.ts";
import type { Mark } from "../../../core/manager/marks.ts";
import { row, TITLE_COLUMN } from "../../../core/manager/row.ts";
import { bold, type Context, counted, failed, type Look, MORE, resultText, textArg } from "./look.ts";
import { errorRows, outputLines, wrappedRows } from "./output.ts";

type Call = {
  name: string;
  args: string;
  status: string;
  durationMs?: number;
  cost?: number;
  error?: string;
};

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n+/;

const OPTIONS_LINE = /^\/\/\s*@options:/;

const STATUS_MARKS: Record<string, Mark> = {
  running: "pending",
  ok: "success",
  error: "error",
  cancelled: "stopped",
};

const scriptOutput = (context: Context) => resultText(context).replace(SCRIPT_HEADER, "");

const isCall = (value: unknown): value is Call =>
  typeof value === "object" && value !== null && typeof (value as Call).name === "string";

const callsOf = (context: Context) => {
  const calls = (context.view.result?.details as { calls?: unknown } | undefined)?.calls;

  return Array.isArray(calls) ? calls.filter(isCall) : [];
};

const callDuration = (ms: number | undefined) =>
  ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

const callCost = (cost: number | undefined) =>
  cost ? `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}` : "";

const callRow = (call: Call, room: number, theme: ThemeLike) => {
  const args = typeof call.args === "string" && call.args !== "" ? ` ${theme.fg("muted", call.args)}` : "";
  const figures = [callDuration(call.durationMs), callCost(call.cost)]
    .filter((figure) => figure !== "")
    .map((figure) => ` ${theme.fg("dim", figure)}`)
    .join("");
  const error =
    call.error && call.status === "error"
      ? wrappedRows(outputLines(call.error), "error", room - TITLE_COLUMN, theme).map((line) => `\n${line}`)
      : [];
  const title = `${call.name}${args}${figures}${error.join("")}`;

  return row({ mark: STATUS_MARKS[call.status] ?? "pending", title })(room, theme);
};

const summary = (calls: Call[], lines: number, theme: ThemeLike) => {
  const broken = calls.filter((call) => call.status === "error").length;
  const ran = [
    ...(calls.length > 0 ? [counted(calls.length, "call", theme)] : []),
    ...(broken > 0 ? [theme.fg("error", `${broken} failed`)] : []),
  ];
  const parts = [
    ...(ran.length > 0 ? [ran.join(theme.fg("muted", ", "))] : []),
    ...(lines > 0 ? [`${counted(lines, "line", theme)}${theme.fg("muted", " of output")}`] : []),
  ];

  return parts.length > 0 ? parts.join(theme.fg("muted", DOT)) : undefined;
};

const sections = (parts: string[][]) =>
  parts.filter((part) => part.length > 0).flatMap((part, index) => (index === 0 ? part : ["", ...part]));

const expanded = (context: Context, room: number, theme: ThemeLike) => {
  const calls = callsOf(context);
  const output = outputLines(scriptOutput(context));
  const head = summary(calls, output.length, theme);
  const script = wrappedRows(outputLines(textArg(context.args, "code") ?? ""), "text", room, theme);
  const token = failed(context) ? "error" : "muted";

  return {
    lines: [
      ...(head === undefined ? [] : [head]),
      ...sections([
        script,
        calls.flatMap((call) => callRow(call, room, theme)),
        wrappedRows(output, token, room, theme),
      ]),
    ],
  };
};

const outcome = (context: Context, room: number, theme: ThemeLike, reasonShown: boolean) => {
  const view = context.view;

  if (view.expanded) {
    return expanded(context, room, theme);
  }

  const calls = callsOf(context);

  if (view.isPartial) {
    return { lines: calls.length > 0 ? [counted(calls.length, "call", theme)] : [] };
  }

  const output = outputLines(scriptOutput(context));

  if (failed(context)) {
    return {
      lines: reasonShown ? [] : errorRows(output.length > 0 ? output : ["Error"], room, context.key, theme),
    };
  }

  const head = summary(calls, output.length, theme);

  return head === undefined
    ? { lines: [theme.fg("muted", "No output")], hint: true }
    : { lines: [head], hint: true };
};

const title = (context: Context) => {
  const code = textArg(context.args, "code");

  if (code === undefined) {
    return undefined;
  }

  const lines = code.trim().split("\n");
  const [first = "", ...rest] = OPTIONS_LINE.test(lines[0] ?? "") ? lines.slice(1) : lines;

  return {
    target: {
      text: first,
      token: "muted" as const,
      cut: "end" as const,
      ...(rest.length > 0 ? { tail: MORE } : {}),
    },
  };
};

export const codemodeLook: Look = {
  verb: bold("codemode"),
  title,
  outcome,
  failure: (context) => {
    const text = scriptOutput(context).trim();

    return text === "" ? undefined : { text };
  },
};
