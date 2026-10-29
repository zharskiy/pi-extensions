import type { KeyPress } from "../../platform/pi-adapter/index.ts";

export const key = (name: KeyPress["name"], char?: string): KeyPress =>
  char === undefined ? { name } : { name, char };

export const char = (value: string): KeyPress => ({
  name: "other",
  char: value,
  shortcut: value,
  raw: value,
});
