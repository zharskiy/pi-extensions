import type { ThemeLike, ThemeToken } from "../../../pi-adapter/index.ts";
import { ELLIPSIS } from "../../../shared/index.ts";
import { cleanLine } from "./output.ts";
import { merged, type Span, wordSpans } from "./words.ts";

type Kind = "added" | "removed" | "context" | "gap";

export type DiffLine = { kind: Kind; num: string; text: string };

type DiffCounts = { added: number; removed: number };

type Line = DiffLine & { spans?: Span[] };

type Changed = "added" | "removed";

const KINDS: Record<string, Kind> = { "+": "added", "-": "removed", " ": "context" };

const MARKS: Record<Kind, string> = { added: "+", removed: "-", context: " ", gap: " " };

const TOKENS: Record<Changed, ThemeToken> = { added: "success", removed: "error" };

const parseLine = (line: string): DiffLine | undefined => {
  if (/^ +\.\.\.$/.test(line)) {
    return { kind: "gap", num: "", text: ELLIPSIS };
  }

  const match = /^([+\- ]) *(\d+)(?: (.*))?$/s.exec(line);

  return match
    ? { kind: KINDS[match[1] ?? " "] ?? "context", num: match[2] ?? "", text: match[3] ?? "" }
    : undefined;
};

export const parseDiff = (diff: string): DiffLine[] | undefined => {
  const lines = diff.replace(/\n+$/, "").split("\n").map(parseLine);

  if (diff.trim() === "" || lines.some((line) => line === undefined)) {
    return undefined;
  }

  return lines as DiffLine[];
};

export const diffCounts = (lines: DiffLine[]): DiffCounts => ({
  added: lines.filter((line) => line.kind === "added").length,
  removed: lines.filter((line) => line.kind === "removed").length,
});

const runsOf = (lines: DiffLine[]) =>
  lines.reduce<DiffLine[][]>((runs, line) => {
    const last = runs[runs.length - 1];

    if (last?.[0]?.kind === line.kind) {
      last.push(line);
    } else {
      runs.push([line]);
    }

    return runs;
  }, []);

const paired = (lines: DiffLine[]): Line[] => {
  const runs = runsOf(lines);
  const spans = new Map<DiffLine, Span[]>();

  runs.forEach((run, index) => {
    const next = runs[index + 1];

    if (run[0]?.kind !== "removed" || next?.[0]?.kind !== "added") {
      return;
    }

    run.forEach((old, at) => {
      const now = next[at];
      const pair = now && wordSpans(old.text, now.text);

      if (now && pair) {
        spans.set(old, pair[0]);
        spans.set(now, pair[1]);
      }
    });
  });

  return lines.map((line) => ({ ...line, spans: spans.get(line) }));
};

type Placed = { start: number; text: string };

type Cursor = { at: number; rows: Placed[] };

const wrapPlain = (text: string, room: number, theme: ThemeLike) =>
  theme.wrap(text, room).reduce<Cursor>(
    (cursor, row) => {
      const found = text.indexOf(row, cursor.at);
      const start = found < 0 ? cursor.at : found;

      return { at: start + row.length, rows: [...cursor.rows, { start, text: row }] };
    },
    { at: 0, rows: [] },
  ).rows;

const sliceSpans = (spans: Span[], row: Placed): Span[] => {
  const end = row.start + row.text.length;
  const offsets = spans.map((_, index) =>
    spans.slice(0, index).reduce((sum, span) => sum + span.text.length, 0),
  );
  const cut = spans
    .map((span, index) => {
      const from = offsets[index] ?? 0;

      return { ...span, text: span.text.slice(Math.max(0, row.start - from), Math.max(0, end - from)) };
    })
    .filter((span) => span.text !== "");

  return cut.map((span) => span.text).join("") === row.text ? cut : [{ text: row.text, changed: false }];
};

const rowsOf = (line: Line, room: number, theme: ThemeLike) => {
  const spans = line.spans ?? [{ text: line.text, changed: false }];

  return wrapPlain(line.text, room, theme).map((row) => sliceSpans(spans, row));
};

const tinted = (line: Line, kind: Changed, gutter: string, room: number, theme: ThemeLike) => {
  const blank = theme.bg(kind, " ".repeat(theme.width(gutter)));
  const lead = `${theme.bg(kind, theme.fg(TOKENS[kind], MARKS[kind]))}${theme.bg(kind, theme.fg("muted", gutter.slice(1)))}`;

  return rowsOf(line, room, theme).map((spans, index) => {
    const used = spans.reduce((sum, span) => sum + theme.width(span.text), 0);
    const pieces = merged([...spans, { text: " ".repeat(Math.max(0, room - used)), changed: false }])
      .filter((piece) => piece.text !== "")
      .map((piece) => theme.bg(piece.changed ? `${kind}Word` : kind, piece.text));

    return `${index === 0 ? lead : blank}${pieces.join("")}`;
  });
};

const plain = (line: Line, kind: Changed, gutter: string, room: number, theme: ThemeLike) => {
  const token = TOKENS[kind];
  const blank = " ".repeat(theme.width(gutter));

  return rowsOf(line, room, theme).map((spans, index) => {
    const text = spans
      .map((span) => (span.changed ? theme.inverse(theme.fg(token, span.text)) : theme.fg(token, span.text)))
      .join("");

    return `${index === 0 ? theme.fg(token, gutter) : blank}${text}`;
  });
};

const context = (line: Line, gutter: string, room: number, theme: ThemeLike) => {
  const blank = " ".repeat(theme.width(gutter));

  return theme
    .wrap(line.text, room)
    .map((row, index) => theme.fg("muted", `${index === 0 ? gutter : blank}${row}`));
};

const diffLine = (line: Line, digits: number, width: number, theme: ThemeLike) => {
  if (line.kind === "gap") {
    return [theme.fg("muted", ELLIPSIS)];
  }

  const gutter = `${MARKS[line.kind]}${line.num.padStart(digits)} `;
  const room = Math.max(1, width - theme.width(gutter));

  if (line.kind === "context") {
    return context(line, gutter, room, theme);
  }

  return theme.panels
    ? tinted(line, line.kind, gutter, room, theme)
    : plain(line, line.kind, gutter, room, theme);
};

export const diffRows = (lines: DiffLine[], width: number, theme: ThemeLike) => {
  const digits = lines.reduce((max, line) => Math.max(max, line.num.length), 0);
  const cleaned = lines.map((line) => ({ ...line, text: cleanLine(line.text) }));

  return paired(cleaned).flatMap((line) => diffLine(line, digits, width, theme));
};
