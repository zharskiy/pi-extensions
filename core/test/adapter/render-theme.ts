import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export const initRenderTheme = () => {
  initTheme(undefined, false);
};

/** pi's `KEYBINDINGS` is not exported, so its `app.tools.expand` default is restated here for pi's own `keyText`. */
export const initRenderKeys = () => {
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    }),
  );
};
