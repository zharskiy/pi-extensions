import type { EditorFrame, EditorLayout, ThemeLike } from "../../../pi-adapter/index.ts";

export const CHEVRON = "›";

const RULE = "─";
const MARGIN = 1;
const MIN_CONTENT = 8;

export const createFrame = (): EditorFrame => {
  const gutter = CHEVRON.length + 1;
  const chrome = MARGIN + gutter;
  const margin = " ".repeat(MARGIN);
  const gutterSpace = " ".repeat(chrome);
  const tail = RULE.repeat(chrome);

  const decorate = (
    lines: string[],
    { bottom, scrolled }: EditorLayout,
    paint: (text: string) => string,
    theme: ThemeLike,
  ) => {
    if (bottom < 1) {
      return lines;
    }

    const extension = paint(tail);
    const lead = scrolled ? gutterSpace : `${margin}${theme.bold(paint(CHEVRON))} `;

    return lines.map((line, index) => {
      if (index === 0) {
        return extension + line;
      }

      if (index === bottom) {
        return line + extension;
      }

      if (index > bottom) {
        return margin + line;
      }

      return (index === 1 ? lead : gutterSpace) + line;
    });
  };

  return { chrome, left: chrome, minWidth: chrome + MIN_CONTENT, decorate };
};
