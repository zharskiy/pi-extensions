export type Span = { text: string; changed: boolean };

type Token = { kind: "word" | "space" | "other"; text: string };

type Changed = { old: boolean[]; now: boolean[] };

const MOSTLY_CHANGED = 0.5;

const MAX_TOKENS = 400;

const graphemes = new Intl.Segmenter();

const kindOf = (grapheme: string): Token["kind"] => {
  if (/^[\p{L}\p{N}_]/u.test(grapheme)) {
    return "word";
  }

  return /^\s+$/u.test(grapheme) ? "space" : "other";
};

const tokens = (text: string) =>
  [...graphemes.segment(text)]
    .reduce<Token[]>((all, { segment }) => {
      const kind = kindOf(segment);
      const last = all[all.length - 1];

      if (last && last.kind === kind && kind !== "other") {
        last.text += segment;
      } else {
        all.push({ kind, text: segment });
      }

      return all;
    }, [])
    .map((token) => token.text);

const lcsTable = (old: string[], now: string[]) =>
  old.reduce(
    (rows, token) => {
      const prev = rows[rows.length - 1] ?? [];
      const row = now.reduce(
        (acc, other, j) => {
          acc.push(token === other ? (prev[j] ?? 0) + 1 : Math.max(prev[j + 1] ?? 0, acc[j] ?? 0));

          return acc;
        },
        [0],
      );

      rows.push(row);

      return rows;
    },
    [now.map(() => 0).concat(0)],
  );

const backtrack = (
  table: number[][],
  old: string[],
  now: string[],
  i: number,
  j: number,
  changed: Changed,
): Changed => {
  if (i === 0 || j === 0) {
    return changed;
  }

  if (old[i - 1] === now[j - 1]) {
    changed.old[i - 1] = false;
    changed.now[j - 1] = false;

    return backtrack(table, old, now, i - 1, j - 1, changed);
  }

  return (table[i - 1]?.[j] ?? 0) >= (table[i]?.[j - 1] ?? 0)
    ? backtrack(table, old, now, i - 1, j, changed)
    : backtrack(table, old, now, i, j - 1, changed);
};

export const merged = (spans: Span[]) =>
  spans.reduce<Span[]>((all, span) => {
    const last = all[all.length - 1];

    if (last && last.changed === span.changed) {
      last.text += span.text;
    } else {
      all.push({ ...span });
    }

    return all;
  }, []);

const spansOf = (parts: string[], changed: boolean[]) =>
  merged(parts.map((text, index) => ({ text, changed: changed[index] ?? true })));

const changedChars = (parts: string[], changed: boolean[]) =>
  parts.reduce((sum, text, index) => sum + (changed[index] ? text.length : 0), 0);

export const wordSpans = (old: string, now: string): [Span[], Span[]] | undefined => {
  const before = tokens(old);
  const after = tokens(now);

  if (before.length + after.length > MAX_TOKENS) {
    return undefined;
  }

  const changed = backtrack(lcsTable(before, after), before, after, before.length, after.length, {
    old: before.map(() => true),
    now: after.map(() => true),
  });
  const total = old.length + now.length;
  const share =
    total === 0 ? 0 : (changedChars(before, changed.old) + changedChars(after, changed.now)) / total;

  return share > MOSTLY_CHANGED ? undefined : [spansOf(before, changed.old), spansOf(after, changed.now)];
};
