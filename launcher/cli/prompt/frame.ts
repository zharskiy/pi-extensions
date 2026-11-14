import { truncate, widthOf } from "./style.ts";
import type { Ui } from "./types.ts";

export interface FrameView {
  lines: string[];
  cursor?: { row: number; column: number };
}

const CSI = "\x1b[";

export const renderFrame = (lines: string[], width: number, ellipsis = "…") =>
  lines.map((line) => truncate(line, Math.max(1, width - 1), ellipsis));

const rowsOf = (line: string, width: number) => Math.max(1, Math.ceil(widthOf(line) / width));

const up = (rows: number) => (rows > 0 ? `${CSI}${rows}A` : "");

export const createFrame = (ui: Ui, ellipsis: string) => {
  const state = { lines: [] as string[], row: 0, column: 0, drawn: false };

  const erasure = () => {
    if (!state.drawn) {
      return "";
    }

    const width = ui.columns();

    const above =
      state.lines.slice(0, state.row).reduce((sum, line) => sum + rowsOf(line, width), 0) +
      Math.floor(state.column / width);

    return `${up(above)}\r${CSI}0J`;
  };

  return {
    draw: (view: FrameView) => {
      const lines = renderFrame(view.lines, ui.columns(), ellipsis);
      const last = lines.length - 1;
      const target = view.cursor ?? { row: last, column: widthOf(lines[last] ?? "") };
      const place = view.cursor === undefined ? "" : `${up(last - target.row)}\r${CSI}${target.column + 1}G`;

      ui.output.write(`${erasure()}${lines.join("\n")}${place}`);

      state.lines = lines;
      state.row = target.row;
      state.column = target.column;
      state.drawn = true;
    },
    clear: () => {
      ui.output.write(erasure());

      state.drawn = false;
    },
  };
};
