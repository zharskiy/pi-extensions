import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { charWidth, innerWidth, PAD, truncateCols } from "./format.ts";

const INDENT = `${PAD}  `;

const stringified = new WeakMap<object, string[]>();

let wrapped: { payload: unknown; cols: number; lines: string[] } | undefined;

const pretty = (payload: unknown): string[] => {
  try {
    const text = JSON.stringify(payload, null, 2);

    return typeof text === "string" ? text.split("\n") : [];
  } catch {
    return [];
  }
};

const linesOf = (payload: unknown): string[] => {
  if (payload === undefined) {
    return [];
  }

  if (typeof payload !== "object" || payload === null) {
    return pretty(payload);
  }

  const cached = stringified.get(payload);

  if (cached) {
    return cached;
  }

  const lines = pretty(payload);

  stringified.set(payload, lines);

  return lines;
};

export const requestLineCount = (payload: unknown): number => linesOf(payload).length;

const wrapLine = (line: string, cols: number): string[] => {
  const parts: string[] = [];
  let current = "";
  let used = 0;

  Array.from(line).forEach((char) => {
    const width = charWidth(char);

    if (used + width > cols && current !== "") {
      parts.push(current);
      current = "";
      used = 0;
    }

    current += char;
    used += width;
  });

  parts.push(current);

  return parts;
};

const wrappedLines = (payload: unknown, cols: number): string[] => {
  if (wrapped && wrapped.payload === payload && wrapped.cols === cols) {
    return wrapped.lines;
  }

  const lines = linesOf(payload).flatMap((line) => wrapLine(line, cols).map((part) => INDENT + part));

  wrapped = { payload, cols, lines };

  return lines;
};

export const requestLines = (
  payload: unknown | undefined,
  open: boolean,
  expanded: boolean,
  width: number,
  theme: ThemeLike,
): string[] => {
  const inner = innerWidth(width);
  const count = requestLineCount(payload);
  const line = (text: string) => PAD + theme.fg("dim", truncateCols(text, inner));

  if (count === 0) {
    return [line(open ? "▸ Request · not sent yet" : "▸ Request · not recorded")];
  }

  if (!expanded) {
    return [line(`▸ Request · ${count} lines`)];
  }

  return [line(`▾ Request · ${count} lines`), ...wrappedLines(payload, Math.max(1, inner - 2)), ""];
};
