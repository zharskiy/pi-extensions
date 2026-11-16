import { stripVTControlCharacters } from "node:util";

const APC = new RegExp(
  `${String.fromCharCode(27)}_[^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`,
  "g",
);

export const plainText = (line: string) => stripVTControlCharacters(line.replace(APC, ""));

export const plainLines = (lines: string[]) => lines.map((line) => plainText(line).trimEnd());

export const visibleWidth = (line: string) => plainText(line).length;
