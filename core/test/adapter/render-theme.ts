import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export const initRenderTheme = () => {
  initTheme(undefined, false);
};

export const initRenderKeys = () => {
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    }),
  );
};
