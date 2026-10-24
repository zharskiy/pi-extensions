import { PAD, type ThemeLike, type ThemeToken } from "../../../../platform/pi-adapter/index.ts";
import { DOT } from "../../../../platform/shared/index.ts";
import { plainReceipt, type ReceiptKind, type ReceiptSegment } from "../../core/components/receipt.ts";

const DROP_ORDER: readonly ReceiptKind[] = ["activity", "cost", "calls", "tokens"];

const fitReceipt = (segments: readonly ReceiptSegment[], room: number, theme: ThemeLike) =>
  DROP_ORDER.reduce<readonly ReceiptSegment[]>(
    (kept, kind) =>
      theme.width(plainReceipt(kept)) <= room ? kept : kept.filter((part) => part.kind !== kind),
    segments,
  );

export const receiptText = (segments: readonly ReceiptSegment[], room: number, theme: ThemeLike) =>
  fitReceipt(segments, room, theme)
    .map((part) => theme.fg(part.token, part.text))
    .join(theme.fg("muted", DOT));

type Painted = readonly [text: string, paint: (text: string) => string];

export const truncatePainted = (theme: ThemeLike, parts: readonly Painted[], cols: number): string => {
  const cut = theme.truncate(parts.map(([text]) => text).join(""), cols);
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

export const padEndCols = (theme: ThemeLike, text: string, cols: number): string =>
  text + " ".repeat(Math.max(0, cols - theme.width(text)));

export const innerWidth = (width: number): number => Math.max(1, width - 2 * PAD.length);

export const padLine = (theme: ThemeLike, token: ThemeToken, text: string, inner: number): string =>
  PAD + theme.fg(token, theme.truncate(text, inner));

export const alignRight = (
  theme: ThemeLike,
  left: string,
  right: string,
  cols: number,
): string | undefined =>
  theme.width(left) + 2 + theme.width(right) > cols
    ? undefined
    : padEndCols(theme, left, cols - theme.width(right)) + right;

const graphemes = new Intl.Segmenter();

export const wrapCols = (theme: ThemeLike, line: string, cols: number): string[] =>
  Array.from(graphemes.segment(line), ({ segment }) => segment).reduce<{ lines: string[]; used: number }>(
    (acc, grapheme) => {
      const width = theme.width(grapheme);

      if (acc.used + width > cols && acc.used > 0) {
        acc.lines.push(grapheme);

        return { lines: acc.lines, used: width };
      }

      acc.lines[acc.lines.length - 1] += grapheme;

      return { lines: acc.lines, used: acc.used + width };
    },
    { lines: [""], used: 0 },
  ).lines;
