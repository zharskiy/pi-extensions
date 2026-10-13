import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { KeyPress } from "./contract.ts";

export type KeyMatchers = {
  isToolsToggle(data: string): boolean;
  isUp(data: string): boolean;
  isDown(data: string): boolean;
};

const KEY_NAMES = [
  ["pageUp", Key.pageUp],
  ["pageDown", Key.pageDown],
  ["home", Key.home],
  ["end", Key.end],
  ["enter", Key.enter],
  ["escape", Key.escape],
  ["space", Key.space],
  ["tab", Key.tab],
] as const;

export const keyPressWith = (data: string, matchers: KeyMatchers): KeyPress => {
  if (matchers.isToolsToggle(data)) {
    return { name: "toggleTools", raw: data };
  }

  if (matchers.isUp(data)) {
    return { name: "up", raw: data };
  }

  if (matchers.isDown(data)) {
    return { name: "down", raw: data };
  }

  const match = KEY_NAMES.find(([, key]) => matchesKey(data, key));

  if (match) {
    return { name: match[0], raw: data };
  }

  return { name: "other", char: data.length === 1 ? data : undefined, raw: data };
};

type KeyMatcher = { matches(data: string, binding: string): boolean };

/** The key as the focused editor sees it: `up`/`down` through pi's `tui.editor.cursorUp/Down` bindings, `toggleTools` through `app.tools.expand`, the rest by `Key.*`. */
export const editorKeyPress = (data: string, keys: KeyMatcher): KeyPress =>
  keyPressWith(data, {
    isToolsToggle: (input) => keys.matches(input, "app.tools.expand"),
    isUp: (input) => keys.matches(input, "tui.editor.cursorUp"),
    isDown: (input) => keys.matches(input, "tui.editor.cursorDown"),
  });
