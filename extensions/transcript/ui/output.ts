import { stripVTControlCharacters } from "node:util";
import type { ThemeLike, ThemeToken } from "../../../pi-adapter/index.ts";
import { countLine, preview } from "../../../ui-kit/index.ts";

const TAB = "   ";

const ERROR_ROWS = 3;

export const cleanLine = (line: string) =>
  stripVTControlCharacters(line)
    .replaceAll("\t", TAB)
    .replace(/\p{Cc}/gu, "");

export const outputLines = (text: string) => {
  const trimmed = text.replace(/\s+$/, "");

  return trimmed === "" ? [] : trimmed.split("\n").map(cleanLine);
};

type Status = { pattern: RegExp; reason: (match: RegExpExecArray) => string; timedOut?: boolean };

const STATUSES: Status[] = [
  { pattern: /^Command exited with code (\d+)$/, reason: (match) => `exit ${match[1]}` },
  {
    pattern: /^Command timed out after (\d+) seconds$/,
    reason: (match) => `timed out after ${match[1]}s`,
    timedOut: true,
  },
  { pattern: /^Command aborted$/, reason: () => "stopped" },
];

type ShellResult = { output: string; reason?: string; timedOut: boolean };

export const shellResult = (text: string): ShellResult => {
  const trimmed = text.replace(/\s+$/, "");
  const cut = trimmed.lastIndexOf("\n");
  const last = trimmed.slice(cut + 1).trim();
  const found = STATUSES.map((status) => ({ status, match: status.pattern.exec(last) })).find(
    (entry) => entry.match !== null,
  );

  if (!found?.match) {
    return { output: text, timedOut: false };
  }

  return {
    output: cut < 0 ? "" : trimmed.slice(0, cut).replace(/\s+$/, ""),
    reason: found.status.reason(found.match),
    timedOut: found.status.timedOut === true,
  };
};

type PreviewSpec = {
  keep: "head" | "tail";
  token: ThemeToken;
  room: number;
  key: string;
};

export const previewRows = (lines: string[], spec: PreviewSpec, theme: ThemeLike) => {
  const { shown, hidden } = preview(lines, { keep: spec.keep });
  const rows = shown.map((line) => theme.fg(spec.token, line));
  const end = spec.keep === "head" ? "more" : "earlier";
  const count = hidden > 0 ? [countLine({ hidden, end, noun: "line", key: spec.key }, spec.room, theme)] : [];

  return spec.keep === "head" ? [...rows, ...count] : [...count, ...rows];
};

export const wrappedRows = (lines: string[], token: ThemeToken, room: number, theme: ThemeLike) =>
  lines.flatMap((line) => theme.wrap(line, Math.max(1, room))).map((row) => theme.fg(token, row));

export const errorRows = (lines: string[], room: number, key: string, theme: ThemeLike) => {
  const wrapped = lines.map((line) => theme.wrap(line, Math.max(1, room)));
  const total = wrapped.reduce((sum, rows) => sum + rows.length, 0);
  const paint = (rows: string[]) => rows.map((row) => theme.fg("error", row));

  if (total <= ERROR_ROWS) {
    return paint(wrapped.flat());
  }

  const budget = ERROR_ROWS - 1;
  const ends = wrapped.map((_, index) =>
    wrapped.slice(0, index + 1).reduce((sum, rows) => sum + rows.length, 0),
  );
  const whole = ends.filter((end) => end <= budget).length;
  const shown = whole === 0 ? (wrapped[0] ?? []).slice(0, budget) : wrapped.slice(0, whole).flat();
  const hidden = lines.length - whole;

  return [...paint(shown), countLine({ hidden, end: "more", noun: "line", key }, room, theme)];
};
