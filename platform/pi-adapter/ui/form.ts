import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { OverlayUi } from "../types/host-ui.ts";
import type { FormFactory } from "../types/view.ts";
import { showCustomView } from "./custom-view.ts";
import { overlaysCleared } from "./overlay.ts";
import { createTextInputs } from "./text-input.ts";
import { themeLike } from "./theme-bridge.ts";

export const createShowForm =
  (
    tuiCtx: () => ExtensionContext | undefined,
    tuiOf: (ctx: ExtensionContext) => Pick<TUI, "hasOverlay"> | undefined,
  ): OverlayUi["showForm"] =>
  async <T>(factory: FormFactory<T>, options: { signal?: AbortSignal } = {}) => {
    const { signal } = options;
    const ctx = tuiCtx();

    if (!ctx || !(await overlaysCleared(tuiOf(ctx), signal)) || signal?.aborted || tuiCtx() !== ctx) {
      return undefined;
    }

    return showCustomView<T | undefined>(ctx, (tui, theme, done) => {
      const inputs = createTextInputs(tui, theme);

      const finish = (result: T | undefined) => {
        signal?.removeEventListener("abort", abort);
        done(result);
      };

      const abort = () => finish(undefined);

      signal?.addEventListener("abort", abort, { once: true });

      const view = factory({
        theme: themeLike(theme),
        requestRender: () => tui.requestRender(),
        done: finish,
        createTextInput: inputs.create,
      });

      return {
        view,
        focus: { get: inputs.focused, set: inputs.focus },
        dispose: () => {
          signal?.removeEventListener("abort", abort);
        },
      };
    });
  };
