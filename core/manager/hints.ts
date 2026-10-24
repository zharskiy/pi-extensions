import type { ThemeLike } from "../../pi-adapter/index.ts";
import { noun } from "./format.ts";
import { DOT, ELLIPSIS, PAD, rule } from "./layout.ts";
import type { Styled } from "./row.ts";

export const EXPAND_BINDING = "app.tools.expand";

const MIN_SUMMARY = 20;

export const expandHint = (key: string): Styled | undefined =>
  key === "" ? undefined : (theme) => theme.fg("dim", `(${key} to expand)`);

export const appendHint = (
  line: string,
  hint: string | undefined,
  width: number,
  theme: ThemeLike,
  options: { cuttable?: boolean } = {},
) => {
  if (hint === undefined) {
    return theme.truncate(line, width);
  }

  const room = width - 1 - theme.width(hint);

  if (theme.width(line) <= room) {
    return `${line} ${hint}`;
  }

  if (options.cuttable && theme.width(line) > width && room >= MIN_SUMMARY) {
    return `${theme.truncate(line, room)} ${hint}`;
  }

  return theme.truncate(line, width);
};

export type CountSpec = {
  hidden: number;
  end: "more" | "earlier";
  noun: "line" | "item";
  key?: string;
};

export const countLine = (spec: CountSpec, width: number, theme: ThemeLike) => {
  const count = `${spec.hidden} ${spec.end} ${noun(spec.hidden, spec.noun)}`;
  const keyed = spec.key ? `${ELLIPSIS} (${count}, ${spec.key} to expand)` : undefined;

  if (spec.key && keyed !== undefined && theme.width(keyed) <= width) {
    return [
      theme.fg("muted", `${ELLIPSIS} (${count}, `),
      theme.fg("dim", spec.key),
      theme.fg("muted", " to expand)"),
    ].join("");
  }

  return theme.truncate(theme.fg("muted", `${ELLIPSIS} (${count})`), width);
};

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

export const framed = (theme: ThemeLike, width: number, lines: string[], hints: readonly KeyHint[]) => [
  rule(theme, width),
  ...lines,
  "",
  ...hintLines(theme, hints, width),
  rule(theme, width),
];
