import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostUi } from "./contract.ts";

export const createWorkingUi = (
  tuiCtx: () => ExtensionContext | undefined,
): Pick<HostUi, "setWorkingIndicator" | "setWorkingMessage"> => ({
  setWorkingIndicator: (indicator) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return;
    }

    if (!indicator) {
      ctx.ui.setWorkingIndicator();
      return;
    }

    ctx.ui.setWorkingIndicator({
      frames: indicator.frames.map((frame) => ctx.ui.theme.fg("accent", frame)),
      intervalMs: indicator.intervalMs,
    });
  },
  setWorkingMessage: (text) => {
    tuiCtx()?.ui.setWorkingMessage(text);
  },
});
