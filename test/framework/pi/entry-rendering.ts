import { stripVTControlCharacters } from "node:util";
import { type EntryRenderer, getMarkdownTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { EntryRender, MessageRender } from "../../../platform/pi-adapter/index.ts";
import { entryHost } from "../../../platform/pi-adapter/tools/entry-renderers.ts";
import { initPiRenderTheme, livePiTheme } from "./render-theme.ts";

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
    livePiTheme,
  );

  return plainLines(component?.render(width) ?? []);
};

export const renderPiUserMessage = (text: string, { width, pad }: { width: number; pad: number }) => {
  initPiRenderTheme();

  return plainLines(new UserMessageComponent(text, getMarkdownTheme(), pad).render(width));
};

export const registerPiMessageRenderer = (customType: string, render: MessageRender) => {
  const host = entryHost({ registerEntryRenderer: () => {}, registerMessageRenderer: () => {} } as never);

  host.registerMessageRenderer(customType, render);

  return host.release;
};
