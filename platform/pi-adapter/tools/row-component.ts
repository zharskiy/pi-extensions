import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { globalRecord } from "../runtime/global-record.ts";
import type { ToolRows } from "../types/tools.ts";
import { CHILD_COLUMN, isBlankLine } from "../ui/row-layout.ts";

type RowsRecord = { rows?: ToolRows; owners?: Map<object, ToolRows>; pad: number };

export const toolRowsRecord = () => globalRecord<RowsRecord>("tool-rows", () => ({ pad: 1 }));

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
  filter?: (line: string) => boolean;
  fallback?: () => Component | undefined;
};

const bodyLines = (body: Component, width: number, filter: (line: string) => boolean) => {
  const lines = body.render(Math.max(1, width)).filter(filter);
  const start = lines.findIndex((line) => !isBlankLine(line));

  return start < 0 ? [] : lines.slice(start);
};

const keepAll = () => true;

class RowComponent implements Component {
  private parts: RowParts;

  private drawn?: { width: number; lines: string[] };

  constructor(parts: RowParts) {
    this.parts = parts;
  }

  set(parts: RowParts) {
    this.parts = parts;
    this.drawn = undefined;

    return this;
  }

  render(width: number): string[] {
    const { lines, pad, body, lead } = this.parts;
    const margin = " ".repeat(pad);
    const drawn = this.own(lines, Math.max(1, width - pad));

    if (!drawn) {
      return this.parts.fallback?.()?.render(width) ?? [];
    }

    const indent = `${margin}${" ".repeat(CHILD_COLUMN)}`;
    const first = drawn.length === 0 && lead !== undefined ? `${margin}${lead}` : indent;
    const shown = body ? bodyLines(body, width - pad - CHILD_COLUMN, this.parts.filter ?? keepAll) : [];
    const hung = shown.map((line, index) =>
      isBlankLine(line) ? "" : `${index === 0 ? first : indent}${line}`,
    );
    const own = drawn.map((line) => (isBlankLine(line) ? "" : `${margin}${line}`));

    return [...own, ...hung].map((line) => truncateToWidth(line, width, "..."));
  }

  private own(lines: RowParts["lines"], width: number) {
    if (this.drawn?.width === width) {
      return this.drawn.lines;
    }

    try {
      this.drawn = { width, lines: lines(width) };

      return this.drawn.lines;
    } catch {
      return undefined;
    }
  }

  invalidate() {
    this.drawn = undefined;
    this.parts.body?.invalidate();
  }
}

export const rowComponent = (previous: unknown, parts: RowParts) =>
  previous instanceof RowComponent ? previous.set(parts) : new RowComponent(parts);
