import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { messageText } from "../runtime/message-text.ts";
import type { EntryRender, Host, MessageRender } from "../types/contract.ts";
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

export const entryHost = (
  pi: Pick<ExtensionAPI, "registerEntryRenderer" | "registerMessageRenderer">,
  entryPad: () => number = sharedPad,
): Pick<Host, "registerEntryRenderer" | "registerMessageRenderer"> => ({
  registerEntryRenderer: (customType, render: EntryRender) => {
    pi.registerEntryRenderer(customType, (entry, options, theme: Theme) =>
      paddedComponent(entryPad, (width) => render(entry.data, width, options.expanded, themeLike(theme))),
    );
  },
  registerMessageRenderer: (customType, render: MessageRender) => {
    pi.registerMessageRenderer(customType, (message, options, theme: Theme) =>
      paddedComponent(
        () => options.outputPad,
        (width) =>
          render(
            { text: messageText(message.content), details: message.details },
            width,
            options.expanded,
            themeLike(theme),
          ),
      ),
    );
  },
});
