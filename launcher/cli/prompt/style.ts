import { stripVTControlCharacters, styleText } from "node:util";
import { isControlChar } from "../../shared/index.ts";

export interface Glyphs {
  header: string;
  end: string;
  rail: string;
  active: string;
  answered: string;
  pointer: string;
  radioOn: string;
  radioOff: string;
  warning: string;
  error: string;
  spinner: string[];
  ellipsis: string;
  upDown: string;
  leftRight: string;
  separator: string;
  above: (count: number) => string;
  below: (count: number) => string;
}

const UNICODE: Glyphs = {
  header: "┌",
  end: "└",
  rail: "│",
  active: "◆",
  answered: "◇",
  pointer: "›",
  radioOn: "●",
  radioOff: "○",
  warning: "▲",
  error: "✖",
  spinner: ["◐", "◓", "◑", "◒"],
  ellipsis: "…",
  upDown: "↑↓",
  leftRight: "←→",
  separator: " · ",
  above: (count) => `↑ ${count} more`,
  below: (count) => `↓ ${count} more`,
};

const ASCII: Glyphs = {
  header: "+",
  end: "+",
  rail: "|",
  active: "*",
  answered: "o",
  pointer: ">",
  radioOn: "(*)",
  radioOff: "( )",
  warning: "!",
  error: "x",
  spinner: ["|", "/", "-", "\\"],
  ellipsis: "...",
  upDown: "up/down",
  leftRight: "left/right",
  separator: ", ",
  above: (count) => `${count} more above`,
  below: (count) => `${count} more below`,
};

export const glyphsOf = (unicode: boolean) => (unicode ? UNICODE : ASCII);

const FOLDS: Array<[string, string]> = [
  [UNICODE.separator, ASCII.separator],
  [UNICODE.ellipsis, ASCII.ellipsis],
  [UNICODE.upDown, ASCII.upDown],
  [UNICODE.leftRight, ASCII.leftRight],
  ["→", "->"],
  ["•", "-"],
  ["✔", "ok"],
  [UNICODE.warning, ASCII.warning],
  [UNICODE.error, ASCII.error],
];

export const asciiOf = (text: string) =>
  FOLDS.reduce((folded, [unicode, ascii]) => folded.replaceAll(unicode, ascii), text);

export type Tone = "cyan" | "yellow" | "red" | "dim";

export type Paint = (tone: Tone, text: string) => string;

export const painterOf =
  (colour: boolean): Paint =>
  (tone, text) =>
    colour && text !== "" ? styleText(tone, text, { validateStream: false }) : text;

export { printable } from "../../shared/index.ts";

const codeOf = (char: string) => char.codePointAt(0) ?? 0;

export const withoutControls = (text: string) =>
  Array.from(text)
    .filter((char) => !isControlChar(char))
    .join("");

const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
];

const within = (ranges: Array<[number, number]>, code: number) =>
  ranges.some(([low, high]) => code >= low && code <= high);

const charWidth = (char: string) => {
  const code = codeOf(char);

  if (within(ZERO, code)) {
    return 0;
  }

  return within(WIDE, code) ? 2 : 1;
};

const plainWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0);

export const widthOf = (text: string) => plainWidth(stripVTControlCharacters(text));

const ESC = String.fromCharCode(27);

const SGR_SPLIT = new RegExp(`(${ESC}\\[[0-9;?]*[ -/]*[@-~])`);

const RESET = `${ESC}[0m`;

interface Cut {
  text: string;
  width: number;
  full: boolean;
  styled: boolean;
}

const cutPart = (cut: Cut, part: string, room: number) => {
  Array.from(part).forEach((char) => {
    const next = cut.width + charWidth(char);

    if (cut.full || next > room) {
      cut.full = true;

      return;
    }

    cut.text += char;
    cut.width = next;
  });
};

export const truncate = (text: string, max: number, ellipsis: string) => {
  if (widthOf(text) <= max) {
    return text;
  }

  const room = Math.max(0, max - widthOf(ellipsis));
  const cut: Cut = { text: "", width: 0, full: false, styled: false };

  text.split(SGR_SPLIT).forEach((part, index) => {
    if (index % 2 === 1) {
      cut.text += part;
      cut.styled = true;

      return;
    }

    cutPart(cut, part, room);
  });

  return `${cut.text}${ellipsis}${cut.styled ? RESET : ""}`;
};

export const tailOf = (text: string, room: number) => {
  const cut: Cut = { text: "", width: 0, full: false, styled: false };

  Array.from(text)
    .reverse()
    .forEach((char) => {
      const next = cut.width + charWidth(char);

      if (cut.full || next > room) {
        cut.full = true;

        return;
      }

      cut.text = `${char}${cut.text}`;
      cut.width = next;
    });

  return cut.text;
};

const joinWhileFits = (pieces: string[], width: number, glue: string, carry: (last: string) => string) => {
  const reserve = widthOf(carry(""));

  return pieces.reduce<string[]>((lines, piece, index) => {
    const last = lines.at(-1);
    const joined = `${last}${glue}${piece}`;
    const trailing = index < pieces.length - 1 ? reserve : 0;

    if (last === undefined || index === 0) {
      lines.push(piece);

      return lines;
    }

    if (widthOf(joined) + trailing <= width) {
      lines[lines.length - 1] = joined;

      return lines;
    }

    lines[lines.length - 1] = carry(last);

    lines.push(piece);

    return lines;
  }, []);
};

const BREAK_AFTER = /(?<=[/,])/;

const hardSplit = (text: string, width: number) =>
  Array.from(text).reduce<string[]>((lines, char) => {
    const last = lines.at(-1);

    if (last !== undefined && plainWidth(`${last}${char}`) <= width) {
      lines[lines.length - 1] = `${last}${char}`;

      return lines;
    }

    lines.push(char);

    return lines;
  }, []);

const fragmentsOf = (word: string, width: number) =>
  joinWhileFits(
    word.split(BREAK_AFTER).flatMap((part) => (widthOf(part) > width ? hardSplit(part, width) : [part])),
    width,
    "",
    (last) => last,
  );

const DOT = UNICODE.separator;

const wordsWrapped = (text: string, room: number) =>
  joinWhileFits(
    text.split(" ").flatMap((word) => (widthOf(word) > room ? fragmentsOf(word, room) : [word])),
    room,
    " ",
    (last) => last,
  );

export const wrap = (line: string, width: number) => {
  const indent = /^ */.exec(line)?.[0] ?? "";
  const room = Math.max(1, width - indent.length);
  const body = line.slice(indent.length);
  const lines =
    body.includes(DOT) && widthOf(body) > room
      ? joinWhileFits(body.split(DOT), room, DOT, (last) => `${last}${DOT.trimEnd()}`).flatMap((part) =>
          wordsWrapped(part, room),
        )
      : wordsWrapped(body, room);

  return lines.map((wrapped) => `${indent}${wrapped}`);
};

export const elapsedOf = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

export const wrapSegments = (segments: string[], width: number, separator: string) =>
  joinWhileFits(segments, width, separator, (last) => `${last}${separator.trimEnd()}`);
