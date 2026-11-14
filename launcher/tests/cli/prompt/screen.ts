const ESC = String.fromCharCode(27);

const TOKEN = new RegExp(`(${ESC}\\[[0-9;?]*[@-~]|${ESC}.|\\r|\\n)`);

const CSI = new RegExp(`^${ESC}\\[([0-9;?]*)([@-~])$`);

export interface Screen {
  write(chunk: string): void;
  resize(width: number): void;
  lines(): string[];
  cursor(): { row: number; column: number };
  flags(): { cursorHidden: boolean; paste: boolean };
}

export const createScreen = (startWidth: number): Screen => {
  const state = {
    width: startWidth,
    rows: [[]] as string[][],
    row: 0,
    column: 0,
    hidden: false,
    paste: false,
  };

  const rowAt = (index: number) => {
    const missing = index + 1 - state.rows.length;

    if (missing > 0) {
      state.rows.push(...Array.from({ length: missing }, () => [] as string[]));
    }

    return state.rows[index] ?? [];
  };

  const put = (char: string) => {
    if (state.column >= state.width) {
      state.row += 1;
      state.column = 0;
    }

    rowAt(state.row)[state.column] = char;
    state.column += 1;
  };

  const mode = (params: string, on: boolean) => {
    if (params === "?25") {
      state.hidden = !on;
    }

    if (params === "?2004") {
      state.paste = on;
    }
  };

  const eraseBelow = (params: string) => {
    if (params === "2") {
      state.rows = [[]];

      return;
    }

    rowAt(state.row).length = Math.min(rowAt(state.row).length, state.column);
    state.rows.length = state.row + 1;
  };

  const eraseLine = (params: string) => {
    const row = rowAt(state.row);

    row.length = params === "2" ? 0 : Math.min(row.length, state.column);
  };

  const csi = (params: string, final: string) => {
    const count = params === "" ? 1 : Number(params);

    switch (final) {
      case "A":
        state.row = Math.max(0, state.row - count);

        return;
      case "B":
        state.row += count;

        return;
      case "C":
        state.column = Math.min(state.width - 1, state.column + count);

        return;
      case "D":
        state.column = Math.max(0, state.column - count);

        return;
      case "G":
        state.column = Math.max(0, count - 1);

        return;
      case "J":
        eraseBelow(params);

        return;
      case "K":
        eraseLine(params);

        return;
      case "h":
      case "l":
        mode(params, final === "h");

        return;
      default:
        return;
    }
  };

  const apply = (token: string) => {
    if (token === "") {
      return;
    }

    if (token === "\r") {
      state.column = 0;

      return;
    }

    if (token === "\n") {
      state.row += 1;
      state.column = 0;

      rowAt(state.row);

      return;
    }

    const sequence = CSI.exec(token);

    if (sequence !== null) {
      csi(sequence[1] ?? "", sequence[2] ?? "");

      return;
    }

    if (!token.startsWith(ESC)) {
      Array.from(token).forEach(put);
    }
  };

  const textOf = (row: string[]) => Array.from(row, (char) => char ?? " ").join("");

  return {
    write: (chunk) => {
      chunk.split(TOKEN).forEach(apply);
    },
    resize: (width) => {
      const pieces = state.rows.map((row) => {
        const text = Array.from(row, (char) => char ?? " ");
        const count = Math.max(1, Math.ceil(text.length / width));

        return Array.from({ length: count }, (_, index) => text.slice(index * width, (index + 1) * width));
      });

      const above = pieces.slice(0, state.row).reduce((sum, rows) => sum + rows.length, 0);

      state.row = above + Math.floor(state.column / width);
      state.column = state.column % width;
      state.rows = pieces.flat();
      state.width = width;
    },
    lines: () => {
      const texts = state.rows.map((row) => textOf(row).trimEnd());
      const last = texts.findLastIndex((text) => text !== "");

      return texts.slice(0, last + 1);
    },
    cursor: () => ({ row: state.row, column: state.column }),
    flags: () => ({ cursorHidden: state.hidden, paste: state.paste }),
  };
};
