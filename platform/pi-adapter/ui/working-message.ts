import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WidgetUi } from "../types/host-ui.ts";

export const createWorkingUi = (
  tuiCtx: () => ExtensionContext | undefined,
): Pick<WidgetUi, "setWorkingMessage" | "setWorkingVisible"> => ({
  setWorkingMessage: (text) => {
    tuiCtx()?.ui.setWorkingMessage(text);
  },
  setWorkingVisible: (visible) => {
    tuiCtx()?.ui.setWorkingVisible(visible);
  },
});
