import type { EditorFrame, EditorLayout } from "../../../core/adapter/contract.ts";

export const CHEVRON = "❯";

const RULE = "─";
const MIN_CONTENT = 8;

const ESC = String.fromCharCode(27);

export const createFrame = (): EditorFrame => {
  const chrome = CHEVRON.length + 1;
  const gutterSpace = " ".repeat(chrome);
  const tail = RULE.repeat(chrome);

  const decorate = (lines: string[], { bottom, scrolled }: EditorLayout, paint: (text: string) => string) => {
    if (bottom < 1) {
      return lines;
    }

    const extension = paint(tail);
    const lead = scrolled ? gutterSpace : `${ESC}[1m${paint(CHEVRON)}${ESC}[22m `;

    return lines.map((line, index) => {
      if (index === 0 || index === bottom) {
        return line + extension;
      }

      if (index > bottom) {
        return gutterSpace + line;
      }

      return (index === 1 ? lead : gutterSpace) + line;
    });
  };

  return { chrome, left: chrome, minWidth: chrome + MIN_CONTENT, decorate };
};
