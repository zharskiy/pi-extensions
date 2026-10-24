import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostUi } from "../types/contract.ts";

export const createWorkingUi = (
  tuiCtx: () => ExtensionContext | undefined,
): Pick<HostUi, "setWorkingMessage" | "setWorkingVisible"> => ({
  setWorkingMessage: (text) => {
    tuiCtx()?.ui.setWorkingMessage(text);
  },
  setWorkingVisible: (visible) => {
    tuiCtx()?.ui.setWorkingVisible(visible);
  },
});
