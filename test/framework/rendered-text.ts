import { stripVTControlCharacters } from "node:util";

export const plainText = (line: string) => stripVTControlCharacters(line);

export const plainLines = (lines: readonly string[]) => lines.map((line) => plainText(line).trimEnd());

export const visibleWidth = (line: string) => plainText(line).length;
