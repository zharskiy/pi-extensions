import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeLike, ToolRender } from "./contract.ts";

export const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(token, text),
  bold: (text) => theme.bold(text),
});

export class WidthText implements Component {
  private source: (width: number) => string;
  private readonly text = new Text("", 0, 0);

  constructor(source: (width: number) => string) {
    this.source = source;
  }

  set(source: (width: number) => string) {
    this.source = source;
  }

  render(width: number): string[] {
    this.text.setText(this.source(width));

    return this.text.render(width);
  }

  invalidate() {
    this.text.invalidate();
  }
}

export const textComponent = (previous: unknown, text: ToolRender): Component => {
  if (typeof text === "function") {
    if (previous instanceof WidthText) {
      previous.set(text);
      return previous;
    }

    return new WidthText(text);
  }

  if (previous instanceof Text) {
    previous.setText(text);
    return previous;
  }

  return new Text(text, 0, 0);
};

export type PaddedSource = string[] | ((width: number) => string);

export class PaddedLines implements Component {
  private lines: PaddedSource;
  private outputPad: number;

  constructor(lines: PaddedSource, outputPad: number) {
    this.lines = lines;
    this.outputPad = outputPad;
  }

  set(lines: PaddedSource, outputPad: number) {
    this.lines = lines;
    this.outputPad = outputPad;
  }

  render(width: number): string[] {
    const pad = " ".repeat(this.outputPad);
    const inner = Math.max(1, width - 2 * this.outputPad);
    const lines = typeof this.lines === "function" ? splitText(this.lines(inner)) : this.lines;

    return lines.flatMap((line) => line.split("\n")).map((line) => pad + truncateToWidth(line, inner, "…"));
  }

  invalidate() {}
}

const splitText = (text: string) => (text === "" ? [] : text.split("\n"));

export const padLines = (lines: PaddedSource, outputPad: number, previous?: unknown): Component => {
  if (previous instanceof PaddedLines) {
    previous.set(lines, outputPad);
    return previous;
  }

  return new PaddedLines(lines, outputPad);
};
