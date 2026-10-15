import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { FormFactory, HostUi, TextInput } from "./contract.ts";
import { keyPress } from "./pi-keys.ts";
import { themeLike } from "./pi-tools.ts";

export const OVERLAY_POLL_MS = 100;

const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (text) => theme.fg("accent", text),
  selectList: {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  },
});

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

const idleComponent = { render: () => [], invalidate: () => {} };

export const createShowForm =
  (
    tuiCtx: () => ExtensionContext | undefined,
    tuiOf: (ctx: ExtensionContext) => Pick<TUI, "hasOverlay"> | undefined,
  ): HostUi["showForm"] =>
  async <T>(factory: FormFactory<T>, options: { signal?: AbortSignal } = {}) => {
    const { signal } = options;
    const ctx = tuiCtx();

    if (!ctx || !(await overlaysCleared(tuiOf(ctx), signal)) || tuiCtx() !== ctx) {
      return undefined;
    }

    return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
      if (signal?.aborted) {
        done(undefined);
        return idleComponent;
      }

      const inputs: Editor[] = [];
      let focused = false;

      const finish = (result: T | undefined) => {
        signal?.removeEventListener("abort", abort);
        done(result);
      };

      const abort = () => finish(undefined);

      const createTextInput = (): TextInput => {
        const editor = new Editor(tui, editorTheme(theme));

        editor.focused = focused;
        inputs.push(editor);

        return {
          render: (width) => editor.render(width),
          handleKey: (key) => {
            if (key.raw !== undefined) {
              editor.handleInput(key.raw);
            }
          },
          text: () => editor.getText(),
          setText: (text) => {
            editor.setText(text);
          },
          onSubmit: (handler) => {
            editor.onSubmit = handler;
          },
        };
      };

      signal?.addEventListener("abort", abort, { once: true });

      const view = factory({
        theme: themeLike(theme),
        requestRender: () => tui.requestRender(),
        done: finish,
        createTextInput,
      });

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          inputs.forEach((editor) => {
            editor.focused = value;
          });
        },
        render: (width: number) => view.render(width).map((line) => truncateToWidth(line, width, "…")),
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
