import type { TUI } from "@earendil-works/pi-tui";

export const OVERLAY_POLL_MS = 100;

export const overlaysCleared = (tui: Pick<TUI, "hasOverlay"> | undefined, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    if (!tui?.hasOverlay()) {
      resolve(true);
      return;
    }

    const finish = (cleared: boolean) => {
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);
      resolve(cleared);
    };

    const abort = () => finish(false);

    const timer = setInterval(() => {
      if (!tui.hasOverlay()) {
        finish(true);
      }
    }, OVERLAY_POLL_MS);

    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
