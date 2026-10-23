import { stripVTControlCharacters } from "node:util";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { CHILD_COLUMNS, type ToolRows } from "./contract.ts";

type RowsRecord = { rows?: ToolRows; owner?: object; pad: number };

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

export type RowParts = {
  lines: (width: number) => string[];
  pad: number;
  body?: Component;
  lead?: string;
};

const isBlank = (line: string) => stripVTControlCharacters(line).trim() === "";

const bodyLines = (body: Component, width: number) => {
  const lines = body.render(Math.max(1, width));
  const start = lines.findIndex((line) => !isBlank(line));

  return start < 0 ? [] : lines.slice(start);
};

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
    const own = lines(Math.max(1, width - pad)).map((line) => `${margin}${line}`);
    const indent = `${margin}${" ".repeat(CHILD_COLUMNS)}`;
    const first = own.length === 0 && lead !== undefined ? `${margin}${lead}` : indent;
    const shown = body ? bodyLines(body, width - pad - CHILD_COLUMNS) : [];
    const hung = shown.map((line, index) => `${index === 0 ? first : indent}${line}`);

    return [...own, ...hung].map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate() {
    this.parts.body?.invalidate();
  }
}

export const rowComponent = (previous: unknown, parts: RowParts) =>
  previous instanceof RowComponent ? previous.set(parts) : new RowComponent(parts);
