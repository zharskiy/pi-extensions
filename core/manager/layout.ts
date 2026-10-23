import type { ThemeLike } from "../adapter/contract.ts";

export const PAD = " ";

export const DOT = " · ";

export const rule = (theme: ThemeLike, width: number) => theme.fg("accent", "─".repeat(Math.max(1, width)));

export const prefixed = (theme: ThemeLike, first: string, text: string, width: number) => {
  const indent = " ".repeat(theme.width(first));

  return theme
    .wrap(text, Math.max(1, width - theme.width(first)))
    .map((line, index) => `${index === 0 ? first : indent}${line}`);
};

export const padded = (theme: ThemeLike, text: string, width: number) => prefixed(theme, PAD, text, width);

export type KeyHint = readonly [key: string, words: string];

export const keyHints = (pairs: readonly KeyHint[], theme: ThemeLike) =>
  pairs
    .map(([key, words]) => `${theme.fg("dim", key)} ${theme.fg("muted", words)}`)
    .join(theme.fg("dim", DOT));

export const hintLines = (theme: ThemeLike, hints: readonly KeyHint[], width: number) => {
  const room = Math.max(1, width - PAD.length);
  const fits = (pairs: readonly KeyHint[]) => theme.width(keyHints(pairs, theme)) <= room;
  const groups = hints.reduce<KeyHint[][]>((lines, hint) => {
    const last = lines.at(-1);

    if (last && fits([...last, hint])) {
      last.push(hint);

      return lines;
    }

    lines.push([hint]);

    return lines;
  }, []);

  return groups.map((pairs) => `${PAD}${theme.truncate(keyHints(pairs, theme), room)}`);
};
