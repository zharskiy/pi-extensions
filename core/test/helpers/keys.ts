import type { KeyPress } from "../../../pi-adapter/index.ts";

export const key = (name: KeyPress["name"]): KeyPress => ({ name });

export const char = (value: string): KeyPress => ({ name: "other", char: value, raw: value });
