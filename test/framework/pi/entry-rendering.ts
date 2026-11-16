import {
  type EntryRenderer,
  type ExtensionAPI,
  getMarkdownTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { EntryRender, MessageRender } from "../../../platform/pi-adapter/index.ts";
import { entryHost } from "../../../platform/pi-adapter/tools/entry-renderers.ts";
import { plainText } from "../rendered-text.ts";
import { initPiRenderTheme, livePiTheme, piKeyHints } from "./render-theme.ts";

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
    { expanded: false, ...piKeyHints },
    livePiTheme,
  );

  return (component?.render(width) ?? []).map(plainText);
};

export const renderPiUserMessage = (text: string, { width, pad }: { width: number; pad: number }) => {
  initPiRenderTheme();

  return new UserMessageComponent(text, getMarkdownTheme(), pad).render(width).map(plainText);
};

export const registerPiMessageRenderer = (customType: string, render: MessageRender) => {
  const host = entryHost(rendererApi());

  host.registerMessageRenderer(customType, render);

  return host.release;
};
