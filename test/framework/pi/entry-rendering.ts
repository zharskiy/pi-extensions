import { stripVTControlCharacters } from "node:util";
import {
  type EntryRenderer,
  getMarkdownTheme,
  type Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { EntryRender } from "../../../platform/pi-adapter/index.ts";
import { entryHost } from "../../../platform/pi-adapter/tools/entry-renderers.ts";
import { initPiRenderTheme } from "./render-theme.ts";

const themes = await import(
  new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);

const plainLines = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

export const renderPiEntry = (
  render: EntryRender,
  data: unknown,
  { width, pad, flush = false }: { width: number; pad: number; flush?: boolean },
) => {
  initPiRenderTheme();

  const registered: EntryRenderer[] = [];
  const api = {
    registerEntryRenderer: (_type: string, renderer: EntryRenderer) => {
      registered.push(renderer);
    },
    registerMessageRenderer: () => {},
  };

  entryHost(api as never, () => pad).registerEntryRenderer("framework:entry", render, { flush });

  const component = registered[0]?.(
    { type: "custom", customType: "framework:entry", data, id: "entry", parentId: null, timestamp: "" },
    { expanded: false },
    themes.theme as Theme,
  );

  return plainLines(component?.render(width) ?? []);
};

export const renderPiUserMessage = (text: string, { width, pad }: { width: number; pad: number }) => {
  initPiRenderTheme();

  return plainLines(new UserMessageComponent(text, getMarkdownTheme(), pad).render(width));
};
