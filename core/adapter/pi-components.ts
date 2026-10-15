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

const splitLines = (text: string) => (text === "" ? [] : text.split("\n"));

export class PaddedLines implements Component {
  private readonly source: ToolRender;

  constructor(source: ToolRender) {
    this.source = source;
  }

  render(width: number): string[] {
    const text = typeof this.source === "function" ? this.source(width) : this.source;

    return splitLines(text).map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate() {}
}
