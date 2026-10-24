import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { KeyPress } from "../types/contract.ts";

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

export const keyPress = (data: string, keys: { matches(data: string, id: string): boolean }): KeyPress => {
  const name =
    BINDINGS.find(([, id]) => keys.matches(data, id))?.[0] ??
    KEY_NAMES.find(([, key]) => matchesKey(data, key))?.[0];

  if (name) {
    return { name, raw: data };
  }

  return { name: "other", char: data.length === 1 ? data : undefined, raw: data };
};
