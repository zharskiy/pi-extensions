import type { Host, RowLines, WidgetHandle } from "../../../../platform/pi-adapter/index.ts";

const WIDGET_KEY = "pi-subagents-agents";

export type PanelWidget = { show(): void; hide(): void };

export const createPanelWidget = (ui: Pick<Host["ui"], "setWidget">, render: RowLines): PanelWidget => {
  let handle: WidgetHandle | undefined;

  return {
    show: () => {
      handle ??= ui.setWidget(WIDGET_KEY, render);
      handle.refresh();
    },
    hide: () => {
      if (handle) {
        ui.setWidget(WIDGET_KEY, undefined);
        handle = undefined;
      }
    },
  };
};
