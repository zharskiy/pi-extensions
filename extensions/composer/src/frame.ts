import type { EditorFrame } from "../../../core/adapter/contract.ts";

const BOX = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", pipe: "│", rule: "─" };

const LEFT = 2;
const RIGHT = 2;
const MIN_CONTENT = 8;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const ALL_RULE = /^─+$/;
const SCROLL_HINT = /^─+ [↑↓] \d+ more /;

export const isRule = (line: string) => {
  if (!line.startsWith(BOX.rule) && !line.startsWith(ESC)) {
    return false;
  }

  const plain = line.replace(ANSI, "");

  return ALL_RULE.test(plain) || SCROLL_HINT.test(plain);
};

const boldWhite = (text: string) => `${ESC}[1m${ESC}[38;2;255;255;255m${text}${ESC}[39m${ESC}[22m`;

export const createFrame = (chevron: string): EditorFrame => {
  const gutter = chevron.length + 1;
  const chrome = LEFT + gutter + RIGHT;
  const leftCap = BOX.rule.repeat(LEFT - 1 + gutter);
  const rightCap = BOX.rule.repeat(RIGHT - 1);
  const gutterSpace = " ".repeat(gutter);
  const outside = " ".repeat(LEFT);
  const prompt = `${boldWhite(chevron)} `;

  const decorate = (lines: string[], paint: (text: string) => string) => {
    const pipe = paint(BOX.pipe);
    const top = { open: paint(BOX.topLeft + leftCap), close: paint(rightCap + BOX.topRight) };
    const bottom = { open: paint(BOX.bottomLeft + leftCap), close: paint(rightCap + BOX.bottomRight) };
    const first = lines.findIndex((line) => !isRule(line));
    const last = first < 0 ? -1 : lines.findIndex((line, index) => index > first && isRule(line));

    return lines.map((line, index) => {
      if (last >= 0 && index > last) {
        return outside + line;
      }

      if (index === last) {
        return bottom.open + line + bottom.close;
      }

      if (first < 0 || index < first) {
        return top.open + line + top.close;
      }

      return `${pipe} ${index === first ? prompt : gutterSpace}${line} ${pipe}`;
    });
  };

  return { chrome, minWidth: chrome + MIN_CONTENT, decorate };
};
