const NAVIGATION_KEYS = ["up", "down", "left", "right", "pageUp", "pageDown", "home", "end"] as const;

export type NavigationKey = (typeof NAVIGATION_KEYS)[number];

export type EditKey = "enter" | "escape" | "space" | "tab" | "backTab" | "backspace";

export type AppKey = "toggleTools";

export type KeyName = NavigationKey | EditKey | AppKey | "other";

export const isNavigationKey = (name: KeyName): name is NavigationKey =>
  NAVIGATION_KEYS.some((key) => key === name);

export type KeyPress = {
  name: KeyName;
  char?: string;
  raw?: string;
};
