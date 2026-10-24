import type { ToolCallView } from "../../../pi-adapter/index.ts";
import { formatDuration, isPlainObject } from "../../../shared/index.ts";

const SLOW_MS = 5000;

const ENOENT = /ENOENT|no such file or directory/i;

export type Args = Record<string, unknown>;

export const argsOf = (view: ToolCallView): Args => (isPlainObject(view.args) ? view.args : {});

const listed = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^\[.*\]$/.test(line));

export const listedCount = (text: string, empty: RegExp) =>
  empty.test(text.trim()) ? 0 : listed(text).length;

const numberArg = (value: unknown) => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};

export const readRange = (args: Args) => {
  const offset = numberArg(args.offset);
  const limit = numberArg(args.limit);

  if (offset === undefined && limit === undefined) {
    return "";
  }

  const start = offset ?? 1;

  return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
};

export const isMissingFile = (text: string) => ENOENT.test(text);

export const diffText = (view: ToolCallView) => {
  const diff = (view.result?.details as { diff?: unknown } | undefined)?.diff;

  return typeof diff === "string" ? diff : undefined;
};

export const slowDuration = (view: ToolCallView, timedOut: boolean | undefined) => {
  if (view.isPartial || view.result === undefined || timedOut) {
    return undefined;
  }

  return view.durationMs !== undefined && view.durationMs >= SLOW_MS
    ? formatDuration(view.durationMs)
    : undefined;
};
