import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./contract.ts";

export const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(token, text),
  bold: (text) => theme.bold(text),
});

export const textComponent = (previous: unknown, text: string): Component => {
  if (previous instanceof Text) {
    previous.setText(text);
    return previous;
  }

  return new Text(text, 0, 0);
};

export class PaddedLines implements Component {
  private lines: string[];
  private outputPad: number;

  constructor(lines: string[], outputPad: number) {
    this.lines = lines;
    this.outputPad = outputPad;
  }

  set(lines: string[], outputPad: number) {
    this.lines = lines;
    this.outputPad = outputPad;
  }

  render(width: number): string[] {
    const pad = " ".repeat(this.outputPad);
    const inner = Math.max(1, width - 2 * this.outputPad);

    return this.lines
      .flatMap((line) => line.split("\n"))
      .map((line) => pad + truncateToWidth(line, inner, "…"));
  }

  invalidate() {}
}

/**
 * A component drawing `lines` as given: each starts at column `outputPad` and is cut at `width - 2 * outputPad`
 * with `…`, never wrapped, so the last `outputPad` columns stay blank (spec §2 "Padding and margins"). A line
 * containing `\n` is split into several lines. Reuses `previous` when it is one.
 */
export const padLines = (lines: string[], outputPad: number, previous?: unknown): Component => {
  if (previous instanceof PaddedLines) {
    previous.set(lines, outputPad);
    return previous;
  }

  return new PaddedLines(lines, outputPad);
};
