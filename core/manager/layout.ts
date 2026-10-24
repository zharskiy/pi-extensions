import { PAD, type ThemeLike } from "../../pi-adapter/index.ts";

export { PAD } from "../../pi-adapter/index.ts";

export const DOT = " · ";

export const ELLIPSIS = "...";

const graphemes = new Intl.Segmenter();

export const cutStart = (text: string, cols: number, theme: Pick<ThemeLike, "width">) => {
  if (theme.width(text) <= cols) {
    return text;
  }

  if (cols <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, Math.max(0, cols));
  }

  const room = cols - ELLIPSIS.length;
  const parts = Array.from(graphemes.segment(text), ({ segment }) => segment).reverse();
  const ends = parts.reduce<number[]>((sums, part) => {
    sums.push((sums.at(-1) ?? 0) + theme.width(part));

    return sums;
  }, []);
  const count = ends.filter((end) => end <= room).length;

  return `${ELLIPSIS}${parts.slice(0, count).reverse().join("")}`;
};

export const rule = (theme: ThemeLike, width: number) => theme.fg("accent", "─".repeat(Math.max(1, width)));

export const prefixed = (theme: ThemeLike, first: string, text: string, width: number) => {
  const indent = " ".repeat(theme.width(first));

  return theme
    .wrap(text, Math.max(1, width - theme.width(first)))
    .map((line, index) => `${index === 0 ? first : indent}${line}`);
};

export const padded = (theme: ThemeLike, text: string, width: number) => prefixed(theme, PAD, text, width);
