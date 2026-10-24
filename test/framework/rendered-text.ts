import { stripVTControlCharacters } from "node:util";

export const plainText = (line: string) => stripVTControlCharacters(line);

export const plainLines = (lines: string[]) => lines.map((line) => plainText(line).trimEnd());

export const visibleWidth = (line: string) => plainText(line).length;
