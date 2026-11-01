import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { globalRecord } from "../runtime/global-record.ts";
import { messageText } from "../runtime/message-text.ts";
import type { EntryHost } from "../types/host-capabilities.ts";
import type { EntryOptions, EntryRender, MessageRender } from "../types/view.ts";
import { fitLines, themeLike } from "../ui/theme-bridge.ts";
import { sharedPad } from "./row-component.ts";

const indentLines = (lines: string[], pad: number, width: number) => {
  const margin = " ".repeat(pad);

  return fitLines(
    lines.map((line) => `${margin}${line}`),
    width,
  );
};

const paddedComponent = (pad: () => number, draw: (width: number) => string[]): Component => ({
  render: (width) => {
    const shift = pad();

    return indentLines(draw(Math.max(1, width - shift)), shift, width);
  },
  invalidate: () => {},
});

type PiMessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

type RendererEntry = { customType: string; owner: object; render: PiMessageRenderer };

const messageRenderersRecord = () =>
  globalRecord<{ entries: RendererEntry[] }>("message-renderers", () => ({ entries: [] }));

export const messageRendererFor = (customType: string): PiMessageRenderer | undefined =>
  messageRenderersRecord().entries.findLast((entry) => entry.customType === customType)?.render;

export const entryHost = (
  pi: Pick<ExtensionAPI, "registerEntryRenderer" | "registerMessageRenderer">,
  entryPad: () => number = sharedPad,
): Pick<EntryHost, "registerEntryRenderer" | "registerMessageRenderer"> & { release: () => void } => {
  const owner = {};

  return {
    release: () => {
      const shared = messageRenderersRecord();

      shared.entries = shared.entries.filter((entry) => entry.owner !== owner);
    },
    registerEntryRenderer: (customType, render: EntryRender, { flush = false }: EntryOptions = {}) => {
      pi.registerEntryRenderer(customType, (entry, options, theme: Theme) => {
        const draw = (width: number) =>
          render(entry.data, width, options.expanded, themeLike(theme), entryPad());

        return paddedComponent(flush ? () => 0 : entryPad, draw);
      });
    },
    registerMessageRenderer: (customType, render: MessageRender) => {
      const piRender: PiMessageRenderer = (message, options, theme: Theme) =>
        paddedComponent(
          () => options.outputPad,
          (width) =>
            render(
              { text: messageText(message.content), details: message.details },
              width,
              options.expanded,
              themeLike(theme),
            ),
        );

      const shared = messageRenderersRecord();

      shared.entries = [
        ...shared.entries.filter((entry) => entry.owner !== owner || entry.customType !== customType),
        { customType, owner, render: piRender },
      ];

      pi.registerMessageRenderer(customType, piRender);
    },
  };
};
