import { Key, matchesKey, parseKey } from "@earendil-works/pi-tui";
import type { KeyPress } from "../types/keys.ts";
import { qwertyTwin } from "./key-layout.ts";

const BINDINGS = [
  ["toggleTools", "app.tools.expand"],
  ["up", "tui.editor.cursorUp"],
  ["down", "tui.editor.cursorDown"],
  ["left", "tui.editor.cursorLeft"],
  ["right", "tui.editor.cursorRight"],
] as const;

const KEY_NAMES = [
  ["pageUp", Key.pageUp],
  ["pageDown", Key.pageDown],
  ["home", Key.home],
  ["end", Key.end],
  ["enter", Key.enter],
  ["escape", Key.escape],
  ["backspace", Key.backspace],
  ["space", Key.space],
  ["tab", Key.tab],
  ["backTab", Key.shift("tab")],
] as const;

const PLAIN_LETTER = /^(shift\+)?([a-z])$/;

const baseLayoutLetter = (data: string) => {
  const match = PLAIN_LETTER.exec(parseKey(data) ?? "");

  if (!match?.[2]) {
    return undefined;
  }

  return match[1] ? match[2].toUpperCase() : match[2];
};

export const keyPress = (data: string, keys: { matches(data: string, id: string): boolean }): KeyPress => {
  const name =
    BINDINGS.find(([, id]) => keys.matches(data, id))?.[0] ??
    KEY_NAMES.find(([, key]) => matchesKey(data, key))?.[0];

  if (name) {
    return { name, raw: data };
  }

  const char = data.length === 1 ? data : undefined;
  const shortcut = char === undefined ? baseLayoutLetter(data) : qwertyTwin(char);

  return { name: "other", char, shortcut, raw: data };
};
