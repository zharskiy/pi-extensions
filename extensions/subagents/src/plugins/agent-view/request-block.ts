import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { innerWidth, PAD, wrapCols } from "../../components/format.ts";

const INDENT = `${PAD}  `;

const stringified = new WeakMap<object, string[]>();

let wrapped: { payload: unknown; cols: number; theme: ThemeLike; lines: string[] } | undefined;

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

const wrappedLines = (payload: unknown, cols: number, theme: ThemeLike): string[] => {
  if (wrapped && wrapped.payload === payload && wrapped.cols === cols && wrapped.theme === theme) {
    return wrapped.lines;
  }

  const lines = linesOf(payload).flatMap((line) => wrapCols(theme, line, cols).map((part) => INDENT + part));

  wrapped = { payload, cols, theme, lines };

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
  const line = (text: string) => PAD + theme.fg("dim", theme.truncate(text, inner));

  if (count === 0) {
    return [line(open ? "▸ Request · not sent yet" : "▸ Request · not recorded")];
  }

  if (!expanded) {
    return [line(`▸ Request · ${count} lines`)];
  }

  return [line(`▾ Request · ${count} lines`), ...wrappedLines(payload, Math.max(1, inner - 2), theme)];
};
