import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { EntryRender, Host, MessageRender } from "./contract.ts";
import { fitLines, themeLike } from "./pi-tools.ts";

type MessageContent = string | { type: string; text?: string }[];

const contentText = (content: MessageContent) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");

export const entryHost = (
  pi: Pick<ExtensionAPI, "registerEntryRenderer" | "registerMessageRenderer">,
): Pick<Host, "registerEntryRenderer" | "registerMessageRenderer"> => ({
  registerEntryRenderer: (customType, render: EntryRender) => {
    pi.registerEntryRenderer(
      customType,
      (entry, options, theme: Theme): Component => ({
        render: (width) => fitLines(render(entry.data, width, options.expanded, themeLike(theme)), width),
        invalidate: () => {},
      }),
    );
  },
  registerMessageRenderer: (customType, render: MessageRender) => {
    pi.registerMessageRenderer(
      customType,
      (message, options, theme: Theme): Component => ({
        render: (width) => {
          const margin = " ".repeat(options.outputPad);
          const lines = render(
            { text: contentText(message.content as MessageContent), details: message.details },
            Math.max(1, width - options.outputPad),
            options.expanded,
            themeLike(theme),
          );

          return fitLines(
            lines.map((line) => `${margin}${line}`),
            width,
          );
        },
        invalidate: () => {},
      }),
    );
  },
});
