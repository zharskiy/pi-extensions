import { stripVTControlCharacters } from "node:util";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { CHILD_COLUMN } from "../manager/row.ts";
import type { ToolRows } from "./contract.ts";

type RowsRecord = { rows?: ToolRows; owners?: Map<object, ToolRows>; pad: number };

const RECORD = Symbol.for("pi-extensions.tool-rows");

export const toolRowsRecord = (): RowsRecord => {
  const store = globalThis as { [RECORD]?: RowsRecord };

  store[RECORD] ??= { pad: 1 };

  return store[RECORD];
};

export const sharedPad = () => toolRowsRecord().pad;

export const recordPad = (pad: unknown) => {
  if (typeof pad === "number") {
    toolRowsRecord().pad = pad;
  }
};

export type RowSlot = { state: object; component?: Component; result?: unknown };

const rowSlots = new WeakMap<object, RowSlot>();

export const slotFor = (state: object) => {
  const slot = rowSlots.get(state) ?? { state: {} };

  rowSlots.set(state, slot);

  return slot;
};

const ABORTED = "Operation aborted";

const RETRIES_ABORTED = /^Aborted after \d+ retry attempts?$/;

const SHELL_ABORTED = "Command aborted";

const SHELLS: readonly string[] = ["bash", "powershell"];

export const abortNotice = (text: string) => {
  const trimmed = text.trim();

  return trimmed === ABORTED || RETRIES_ABORTED.test(trimmed);
};

export const abortedText = (text: string, name: string) => {
  if (abortNotice(text)) {
    return true;
  }

  const trimmed = text.trim();

  const last = trimmed
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1);

  return SHELLS.includes(name) && last?.trim() === SHELL_ABORTED;
};

export type RowParts = {
  lines: (width: number) => string[];
  pad: number;
  body?: Component;
  lead?: string;
  indent?: number;
  filter?: (line: string) => boolean;
  fallback?: () => Component | undefined;
};

const isBlank = (line: string) => stripVTControlCharacters(line).trim() === "";

const bodyLines = (body: Component, width: number, filter: (line: string) => boolean) => {
  const lines = body.render(Math.max(1, width)).filter(filter);
  const start = lines.findIndex((line) => !isBlank(line));

  return start < 0 ? [] : lines.slice(start);
};

const keepAll = () => true;

export class RowComponent implements Component {
  private parts: RowParts;

  constructor(parts: RowParts) {
    this.parts = parts;
  }

  set(parts: RowParts) {
    this.parts = parts;

    return this;
  }

  render(width: number): string[] {
    const { lines, pad, body, lead } = this.parts;
    const margin = " ".repeat(pad);
    const drawn = this.own(lines, Math.max(1, width - pad));

    if (!drawn) {
      return this.parts.fallback?.()?.render(width) ?? [];
    }

    const columns = this.parts.indent ?? CHILD_COLUMN;
    const indent = `${margin}${" ".repeat(columns)}`;
    const first = drawn.length === 0 && lead !== undefined ? `${margin}${lead}` : indent;
    const shown = body ? bodyLines(body, width - pad - columns, this.parts.filter ?? keepAll) : [];
    const hung = shown.map((line, index) => (isBlank(line) ? "" : `${index === 0 ? first : indent}${line}`));
    const own = drawn.map((line) => (isBlank(line) ? "" : `${margin}${line}`));

    return [...own, ...hung].map((line) => truncateToWidth(line, width, "..."));
  }

  private own(lines: RowParts["lines"], width: number) {
    try {
      return lines(width);
    } catch {
      return undefined;
    }
  }

  invalidate() {
    this.parts.body?.invalidate();
  }
}

export const rowComponent = (previous: unknown, parts: RowParts) =>
  previous instanceof RowComponent ? previous.set(parts) : new RowComponent(parts);
