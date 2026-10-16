import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { EntryRender, Host } from "./contract.ts";
import { fitLines, themeLike } from "./pi-tools.ts";

export const entryHost = (
  pi: Pick<ExtensionAPI, "registerEntryRenderer">,
): Pick<Host, "registerEntryRenderer"> => ({
  registerEntryRenderer: (customType, render: EntryRender) => {
    pi.registerEntryRenderer(
      customType,
      (entry, options, theme: Theme): Component => ({
        render: (width) => fitLines(render(entry.data, width, options.expanded, themeLike(theme)), width),
        invalidate: () => {},
      }),
    );
  },
});
