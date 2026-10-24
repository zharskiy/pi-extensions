import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { FormFactory, HostUi } from "../types/contract.ts";
import { keyPress } from "./key-events.ts";
import { overlaysCleared } from "./overlay.ts";
import { createTextInputs } from "./text-input.ts";
import { fitLines, themeLike } from "./theme-bridge.ts";

export const createShowForm =
  (
    tuiCtx: () => ExtensionContext | undefined,
    tuiOf: (ctx: ExtensionContext) => Pick<TUI, "hasOverlay"> | undefined,
  ): HostUi["showForm"] =>
  async <T>(factory: FormFactory<T>, options: { signal?: AbortSignal } = {}) => {
    const { signal } = options;
    const ctx = tuiCtx();

    if (!ctx || !(await overlaysCleared(tuiOf(ctx), signal)) || signal?.aborted || tuiCtx() !== ctx) {
      return undefined;
    }

    return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
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
        get focused() {
          return inputs.focused();
        },
        set focused(value: boolean) {
          inputs.focus(value);
        },
        render: (width: number) => fitLines(view.render(width), width),
        handleInput: (data: string) => {
          view.handleKey(keyPress(data, keybindings));
          tui.requestRender();
        },
        invalidate: () => {},
        dispose: () => {
          signal?.removeEventListener("abort", abort);
          view.dispose?.();
        },
      };
    });
  };
