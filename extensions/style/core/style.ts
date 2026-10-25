import type { Host } from "../../../platform/pi-adapter/index.ts";
import { DEFAULT_STYLE, NORMAL, type Style } from "./styles.ts";

export const SECTION = "output_style";

export const createStyleSection = (host: Host, styles: ReadonlyMap<string, Style>) => {
  const names = [...styles.keys(), NORMAL];
  let current = NORMAL;

  const apply = (name: string) => {
    current = name;
    host.setPromptSection(SECTION, styles.get(name)?.prompt);
  };

  const fallback = styles.has(DEFAULT_STYLE) ? DEFAULT_STYLE : NORMAL;

  return { names, fallback, current: () => current, apply };
};
