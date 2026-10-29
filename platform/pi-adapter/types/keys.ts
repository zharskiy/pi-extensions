type NavigationKey = "up" | "down" | "left" | "right" | "pageUp" | "pageDown" | "home" | "end";

type EditKey = "enter" | "escape" | "space" | "tab" | "backTab" | "backspace";

type AppKey = "toggleTools";

type KeyName = NavigationKey | EditKey | AppKey | "other";

export type KeyPress = {
  name: KeyName;
  char?: string;
  shortcut?: string;
  raw?: string;
};
