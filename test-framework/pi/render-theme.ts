import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export const initPiRenderTheme = () => {
  initTheme(undefined, false);
};

export const initPiKeybindings = () => {
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    }),
  );
};

export const plainPiTheme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_token: string, text: string) => text,
} as unknown as Theme;
