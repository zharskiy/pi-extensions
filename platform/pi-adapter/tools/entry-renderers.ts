import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { globalRecord } from "../runtime/global-record.ts";
import { messageText } from "../runtime/message-text.ts";
import type { EntryHost } from "../types/host-capabilities.ts";
import type { ThemeLike } from "../types/theme.ts";
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

const paddedComponent = (
  pad: () => number,
  flush: boolean,
  draw: (width: number, pad: number) => string[],
  invalidate: () => void = () => {},
): Component => ({
  render: (width) => {
    const read = pad();
    const shift = flush ? 0 : read;

    return indentLines(draw(Math.max(1, width - shift), read), shift, width);
  },
  invalidate,
});

type RailOptions = EntryOptions & { invalidate?: () => void };

type PiMessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

type RendererEntry = { customType: string; owner: object; render: PiMessageRenderer };

const messageRenderersRecord = () =>
  globalRecord<{ entries: RendererEntry[] }>("message-renderers", () => ({ entries: [] }));

export const messageRendererFor = (customType: string): PiMessageRenderer | undefined =>
  messageRenderersRecord().entries.findLast((entry) => entry.customType === customType)?.render;

type EntryRecord = {
  customType: string;
  owner: object;
  render: EntryRender;
  pad: () => number;
  flush: boolean;
  previousSession: boolean;
};

const entryRenderersRecord = () =>
  globalRecord<{ entries: EntryRecord[] }>("entry-renderers", () => ({ entries: [] }));

export const previousEntryComponent = (customType: string, data: unknown, theme: () => ThemeLike) => {
  const entry = entryRenderersRecord().entries.findLast((record) => record.customType === customType);

  if (!entry?.previousSession) {
    return undefined;
  }

  let expanded = false;

  return {
    ...paddedComponent(entry.pad, entry.flush, (width, pad) =>
      entry.render(data, width, expanded, theme(), pad),
    ),
    setExpanded: (value: boolean) => {
      expanded = value;
    },
  };
};

export const entryHost = (
  pi: Pick<ExtensionAPI, "registerEntryRenderer" | "registerMessageRenderer">,
  entryPad: () => number = sharedPad,
): Pick<EntryHost, "registerMessageRenderer"> & {
  registerEntryRenderer(customType: string, render: EntryRender, options?: RailOptions): void;
  release: () => void;
} => {
  const owner = {};

  return {
    release: () => {
      const shared = messageRenderersRecord();
      const entries = entryRenderersRecord();

      shared.entries = shared.entries.filter((entry) => entry.owner !== owner);
      entries.entries = entries.entries.filter((entry) => entry.owner !== owner);
    },
    registerEntryRenderer: (
      customType,
      render,
      { flush = false, previousSession = true, invalidate }: RailOptions = {},
    ) => {
      const shared = entryRenderersRecord();

      shared.entries = [
        ...shared.entries.filter((entry) => entry.owner !== owner || entry.customType !== customType),
        { customType, owner, render, pad: entryPad, flush, previousSession },
      ];

      pi.registerEntryRenderer(customType, (entry, options, theme: Theme) =>
        paddedComponent(
          entryPad,
          flush,
          (width, pad) => render(entry.data, width, options.expanded, themeLike(theme), pad),
          invalidate,
        ),
      );
    },
    registerMessageRenderer: (customType, render: MessageRender) => {
      const piRender: PiMessageRenderer = (message, options, theme: Theme) =>
        paddedComponent(
          () => options.outputPad,
          false,
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
