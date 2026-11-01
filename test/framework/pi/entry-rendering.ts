import { stripVTControlCharacters } from "node:util";
import {
  type EntryRenderer,
  type ExtensionAPI,
  getMarkdownTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { EntryRender, MessageRender } from "../../../platform/pi-adapter/index.ts";
import { entryHost } from "../../../platform/pi-adapter/tools/entry-renderers.ts";
import { initPiRenderTheme, livePiTheme } from "./render-theme.ts";

const plainLines = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

type RendererApi = Pick<ExtensionAPI, "registerEntryRenderer" | "registerMessageRenderer">;

const rendererApi = (onEntry: (renderer: EntryRenderer) => void = () => {}): RendererApi => ({
  registerEntryRenderer: (_type, renderer) => {
    onEntry(renderer as EntryRenderer);
  },
  registerMessageRenderer: () => {},
});

export const renderPiEntry = (
  render: EntryRender,
  data: unknown,
  { width, pad, flush = false }: { width: number; pad: number; flush?: boolean },
) => {
  initPiRenderTheme();

  const registered: EntryRenderer[] = [];
  const api = rendererApi((renderer) => {
    registered.push(renderer);
  });

  entryHost(api, () => pad).registerEntryRenderer("framework:entry", render, { flush });

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
  const host = entryHost(rendererApi());

  host.registerMessageRenderer(customType, render);

  return host.release;
};
