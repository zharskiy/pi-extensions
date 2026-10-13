export { formatDuration, formatTokens } from "../../../../core/manager/format.ts";

export const SEP = " · ";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const formatToolUses = (n: number): string => plural(n, "tool use");

export const formatAgents = (n: number): string => plural(n, "agent");

export const formatCtx = (percent: number | null | undefined): string | undefined =>
  percent === null || percent === undefined ? undefined : `${Math.round(percent)}% ctx`;

export const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

export const elapsedOf = (
  record: { startedAt?: number; createdAt: number; endedAt?: number },
  now: number,
): number => (record.endedAt ?? now) - (record.startedAt ?? record.createdAt);

const ESC = String.fromCharCode(27);

const BEL = String.fromCharCode(7);

const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");

const stripAnsi = (text: string) => text.replace(ANSI, "");

type Range = [number, number];

const inRanges = (cp: number, ranges: Range[]) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

const ZERO: Range[] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0x2060, 0x2064],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];

const WIDE: Range[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

export const charWidth = (char: string): number => {
  const cp = char.codePointAt(0) ?? 0;

  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || inRanges(cp, ZERO)) {
    return 0;
  }

  return inRanges(cp, WIDE) ? 2 : 1;
};

export const displayWidth = (text: string): number =>
  Array.from(stripAnsi(text)).reduce((sum, char) => sum + charWidth(char), 0);

export const truncateCols = (text: string, cols: number): string => {
  if (cols <= 0) {
    return "";
  }

  if (displayWidth(text) <= cols) {
    return text;
  }

  const chars = Array.from(text);
  const budget = cols - 1;
  const widths = chars.map(charWidth);
  const ends = widths.reduce<number[]>((acc, width) => {
    acc.push((acc.at(-1) ?? 0) + width);

    return acc;
  }, []);
  const fits = ends.findIndex((end) => end > budget);
  const count = fits < 0 ? chars.length : fits;

  return `${chars.slice(0, count).join("").trimEnd()}…`;
};

type Painted = readonly [text: string, paint: (text: string) => string];

/** Cuts the joined texts at `cols` like `truncateCols`, then paints what is left of each part with its own paint. */
export const truncatePainted = (parts: readonly Painted[], cols: number): string => {
  const cut = truncateCols(parts.map(([text]) => text).join(""), cols);
  const starts = parts.reduce<number[]>(
    (acc, [text]) => {
      acc.push((acc.at(-1) ?? 0) + text.length);

      return acc;
    },
    [0],
  );

  return parts
    .map(([, paint], index) => {
      const piece = cut.slice(starts[index], starts[index + 1]);

      return piece ? paint(piece) : "";
    })
    .join("");
};

export const padEndCols = (text: string, cols: number): string =>
  text + " ".repeat(Math.max(0, cols - displayWidth(text)));

export const PAD = " ";

export const innerWidth = (width: number): number => Math.max(1, width - 2 * PAD.length);

export const alignRight = (left: string, right: string, cols: number): string | undefined =>
  displayWidth(left) + 2 + displayWidth(right) > cols
    ? undefined
    : padEndCols(left, cols - displayWidth(right)) + right;
