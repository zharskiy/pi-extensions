import { stripVTControlCharacters } from "node:util";
import type { ThemeLike } from "../types/contract.ts";

export const PAD = " ";

export const CHILD_COLUMN = 4;

export const CHILD_MARK = "↳";

export const isBlankLine = (line: string) => stripVTControlCharacters(line).trim() === "";

export const childLead = (theme: ThemeLike) => `  ${theme.fg("dim", CHILD_MARK)} `;
