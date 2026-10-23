import type { BgToken, ThemeLike } from "../../../core/adapter/contract.ts";

export type DiffCounts = { added: number; removed: number };

export const diffCounts = (diff: string): DiffCounts => {
  const changed = diff.split("\n").filter((line) => /^[+-]\s*\d/.test(line));

  return {
    added: changed.filter((line) => line.startsWith("+")).length,
    removed: changed.filter((line) => line.startsWith("-")).length,
  };
};

type Kind = "add" | "del" | "ctx" | "gap";

export type DiffLine = { kind: Kind; num: string; text: string };

type Span = { text: string; changed: boolean };

type Line = DiffLine & { spans?: Span[] };

const MOSTLY_CHANGED = 0.5;

const MAX_TOKENS = 400;

const TAB = "    ";

const KINDS: Record<string, Kind> = { "+": "add", "-": "del", " ": "ctx" };

const MARKS: Record<Kind, string> = { add: "+", del: "-", ctx: " ", gap: " " };

const parseLine = (line: string): DiffLine | undefined => {
  if (/^ +\.\.\.$/.test(line)) {
    return { kind: "gap", num: "", text: "..." };
  }

  const match = /^([+\- ]) *(\d+)(?: (.*))?$/.exec(line);

  return match
    ? { kind: KINDS[match[1] ?? " "] ?? "ctx", num: match[2] ?? "", text: match[3] ?? "" }
    : undefined;
};

export const parseDiff = (diff: string): DiffLine[] | undefined => {
  const lines = diff.replace(/\n+$/, "").split("\n").map(parseLine);

  if (diff.trim() === "" || lines.some((line) => line === undefined)) {
    return undefined;
  }

  return lines as DiffLine[];
};

const merged = (spans: Span[]) =>
  spans.reduce<Span[]>((all, span) => {
    const last = all[all.length - 1];

    if (last && last.changed === span.changed) {
      last.text += span.text;
    } else {
      all.push({ ...span });
    }

    return all;
  }, []);

const tokens = (text: string) => text.match(/\w+|\s+|[^\w\s]/g) ?? [];

const lcsTable = (a: string[], b: string[]) =>
  a.reduce(
    (rows, token) => {
      const prev = rows[rows.length - 1] ?? [];
      const row = b.reduce(
        (acc, other, j) => {
          acc.push(token === other ? (prev[j] ?? 0) + 1 : Math.max(prev[j + 1] ?? 0, acc[j] ?? 0));

          return acc;
        },
        [0],
      );

      rows.push(row);

      return rows;
    },
    [b.map(() => 0).concat(0)],
  );

type Marks = { a: boolean[]; b: boolean[] };

const backtrack = (
  table: number[][],
  a: string[],
  b: string[],
  i: number,
  j: number,
  marks: Marks,
): Marks => {
  if (i === 0 || j === 0) {
    return marks;
  }

  if (a[i - 1] === b[j - 1]) {
    marks.a[i - 1] = false;
    marks.b[j - 1] = false;

    return backtrack(table, a, b, i - 1, j - 1, marks);
  }

  return (table[i - 1]?.[j] ?? 0) >= (table[i]?.[j - 1] ?? 0)
    ? backtrack(table, a, b, i - 1, j, marks)
    : backtrack(table, a, b, i, j - 1, marks);
};

const spansOf = (parts: string[], changed: boolean[]) =>
  merged(parts.map((text, index) => ({ text, changed: changed[index] ?? true })));

const changedShare = (parts: string[], changed: boolean[]) =>
  parts.reduce((sum, text, index) => sum + (changed[index] ? text.length : 0), 0);

const wordSpans = (old: string, now: string): [Span[], Span[]] | undefined => {
  const a = tokens(old);
  const b = tokens(now);

  if (a.length + b.length > MAX_TOKENS) {
    return undefined;
  }

  const marks = backtrack(lcsTable(a, b), a, b, a.length, b.length, {
    a: a.map(() => true),
    b: b.map(() => true),
  });
  const total = old.length + now.length;
  const share = total === 0 ? 0 : (changedShare(a, marks.a) + changedShare(b, marks.b)) / total;

  return share > MOSTLY_CHANGED ? undefined : [spansOf(a, marks.a), spansOf(b, marks.b)];
};

const withSpans = (old: DiffLine, now: DiffLine, side: 0 | 1): Line => {
  const spans = wordSpans(old.text.replaceAll("\t", TAB), now.text.replaceAll("\t", TAB));
  const line = side === 0 ? old : now;

  return spans ? { ...line, spans: spans[side] } : line;
};

const runsOf = (lines: DiffLine[]) =>
  lines.reduce<DiffLine[][]>((runs, line) => {
    const last = runs[runs.length - 1];

    if (last?.[0]?.kind === line.kind) {
      last.push(line);

      return runs;
    }

    runs.push([line]);

    return runs;
  }, []);

const paired = (lines: DiffLine[]): Line[] => {
  const runs = runsOf(lines);

  return runs.flatMap((run, index): Line[] => {
    const before = runs[index - 1];
    const after = runs[index + 1];

    if (run[0]?.kind === "del" && after?.[0]?.kind === "add") {
      return run.map((line, at) => {
        const partner = after[at];

        return partner ? withSpans(line, partner, 0) : line;
      });
    }

    if (run[0]?.kind === "add" && before?.[0]?.kind === "del") {
      return run.map((line, at) => {
        const partner = before[at];

        return partner ? withSpans(partner, line, 1) : line;
      });
    }

    return run;
  });
};

const LINE_BG: Record<"add" | "del", BgToken> = { add: "added", del: "removed" };

const WORD_BG: Record<"add" | "del", BgToken> = { add: "addedWord", del: "removedWord" };

const fitSpans = (spans: Span[], room: number, theme: ThemeLike) => {
  const total = spans.reduce((sum, span) => sum + theme.width(span.text), 0);

  if (total <= room) {
    return spans;
  }

  return spans.reduce(
    (state, span) => {
      if (state.done) {
        return state;
      }

      const width = theme.width(span.text);

      if (width <= state.budget) {
        return { kept: [...state.kept, span], budget: state.budget - width, done: false };
      }

      return {
        kept: [...state.kept, { ...span, text: theme.truncate(span.text, state.budget + 1) }],
        budget: 0,
        done: true,
      };
    },
    { kept: [] as Span[], budget: room - 1, done: false },
  ).kept;
};

const diffLine = (line: Line, digits: number, width: number, theme: ThemeLike) => {
  const gutter = `${line.num.padStart(digits)} ${MARKS[line.kind]} `;
  const room = Math.max(1, width - gutter.length);
  const text = line.text.replaceAll("\t", TAB);

  if (line.kind === "ctx" || line.kind === "gap") {
    return theme.fg("dim", `${gutter}${theme.truncate(text, room)}`);
  }

  const kind = line.kind;
  const spans = fitSpans(line.spans ?? [{ text, changed: false }], room, theme);
  const used = spans.reduce((sum, span) => sum + theme.width(span.text), 0);
  const mark = theme.fg(kind === "add" ? "success" : "error", MARKS[kind]);
  const pieces = merged([
    { text: `${line.num.padStart(digits)} ${mark} `, changed: false },
    ...spans,
    { text: " ".repeat(Math.max(0, room - used)), changed: false },
  ]);

  return pieces.map((piece) => theme.bg(piece.changed ? WORD_BG[kind] : LINE_BG[kind], piece.text)).join("");
};

export const diffRows = (lines: DiffLine[], width: number, theme: ThemeLike) => {
  const digits = lines.reduce((max, line) => Math.max(max, line.num.length), 0);

  return paired(lines).map((line) => diffLine(line, digits, width, theme));
};
