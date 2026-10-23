import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { merged, type Span, wordSpans } from "./words.ts";

type Kind = "added" | "removed" | "context" | "gap";

export type DiffLine = { kind: Kind; num: string; text: string };

export type DiffCounts = { added: number; removed: number };

type Line = DiffLine & { spans?: Span[] };

const TAB = "   ";

const KINDS: Record<string, Kind> = { "+": "added", "-": "removed", " ": "context" };

const MARKS: Record<Kind, string> = { added: "+", removed: "-", context: " ", gap: " " };

const parseLine = (line: string): DiffLine | undefined => {
  if (/^ +\.\.\.$/.test(line)) {
    return { kind: "gap", num: "", text: "..." };
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

export const diffCounts = (lines: DiffLine[] | undefined): DiffCounts => ({
  added: lines?.filter((line) => line.kind === "added").length ?? 0,
  removed: lines?.filter((line) => line.kind === "removed").length ?? 0,
});

const clean = (text: string) => text.replaceAll("\t", TAB).replace(/\p{Cc}/gu, "");

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

const ELLIPSIS = "...";

const fitSpans = (spans: Span[], room: number, theme: ThemeLike): Span[] => {
  const plain = spans.map((span) => span.text).join("");
  const cut = theme.truncate(plain, room);

  if (cut === plain) {
    return spans;
  }

  const kept = cut.endsWith(ELLIPSIS) ? cut.slice(0, -ELLIPSIS.length) : "";
  const tail = cut.slice(kept.length);
  const ends = spans.reduce<number[]>((all, span) => {
    all.push((all[all.length - 1] ?? 0) + span.text.length);

    return all;
  }, []);
  const sliced = spans
    .map((span, index) => {
      const end = ends[index] ?? 0;

      return { ...span, text: kept.slice(end - span.text.length, end) };
    })
    .filter((span) => span.text !== "");
  const last = sliced[sliced.length - 1];

  return last
    ? [...sliced.slice(0, -1), { ...last, text: `${last.text}${tail}` }]
    : [{ text: tail, changed: false }];
};

const diffLine = (line: Line, digits: number, width: number, theme: ThemeLike) => {
  const gutter = `${line.num.padStart(digits)} ${MARKS[line.kind]} `;
  const room = Math.max(1, width - gutter.length);

  if (line.kind === "context" || line.kind === "gap") {
    return theme.fg("dim", `${gutter}${theme.truncate(line.text, room)}`);
  }

  const kind = line.kind;
  const spans = fitSpans(line.spans ?? [{ text: line.text, changed: false }], room, theme);
  const used = spans.reduce((sum, span) => sum + theme.width(span.text), 0);
  const mark = theme.fg(kind === "added" ? "success" : "error", MARKS[kind]);
  const pieces = merged([
    { text: `${line.num.padStart(digits)} ${mark} `, changed: false },
    ...spans,
    { text: " ".repeat(Math.max(0, room - used)), changed: false },
  ]);

  return pieces
    .filter((piece) => piece.text !== "")
    .map((piece) => theme.bg(piece.changed ? `${kind}Word` : kind, piece.text))
    .join("");
};

export const diffRows = (lines: DiffLine[], width: number, theme: ThemeLike) => {
  const digits = lines.reduce((max, line) => Math.max(max, line.num.length), 0);
  const cleaned = lines.map((line) => ({ ...line, text: clean(line.text) }));

  return paired(cleaned).map((line) => diffLine(line, digits, width, theme));
};
