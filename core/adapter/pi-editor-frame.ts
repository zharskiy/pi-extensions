import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { EditorFrame, EditorKeyHandler, HostUi } from "./contract.ts";
import { editorKeyPress } from "./pi-ui.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

type EditorHooks = { frame?: EditorFrame; emptyLeft: Set<() => void>; capture?: EditorKeyHandler };

class HostEditor extends CustomEditor {
  private readonly keys: KeybindingsManager;
  private readonly hooks: EditorHooks;
  private bottomBorder = "";
  private scrolled = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: EditorHooks) {
    super(tui, theme, keybindings);
    this.keys = keybindings;
    this.hooks = hooks;
  }

  protected renderTopBorder(width: number, hidden: number): string {
    this.scrolled = hidden > 0;

    return super.renderTopBorder(width, hidden);
  }

  protected renderBottomBorder(width: number, hidden: number): string {
    this.bottomBorder = super.renderBottomBorder(width, hidden);

    return this.bottomBorder;
  }

  render(width: number): string[] {
    const frame = this.hooks.frame;

    if (!frame || width < frame.minWidth) {
      return super.render(width);
    }

    const lines = super.render(width - frame.chrome);
    const bottom = lines.indexOf(this.bottomBorder, 1);

    return frame.decorate(lines, { bottom, scrolled: this.scrolled }, this.borderColor);
  }

  handleMouse(event: TuiMouseEvent) {
    const frame = this.hooks.frame;

    if (!frame || event.width < frame.minWidth) {
      return super.handleMouse(event);
    }

    return super.handleMouse({
      ...event,
      x: Math.max(0, event.x - frame.left),
      width: event.width - frame.chrome,
    });
  }

  handleInput(data: string) {
    const capture = this.hooks.capture;

    if (capture) {
      if (capture(editorKeyPress(data, this.keys)) === "consumed") {
        return;
      }

      if (this.hooks.capture === capture) {
        this.hooks.capture = undefined;
      }
    }

    if (
      this.hooks.emptyLeft.size > 0 &&
      this.keys.matches(data, "tui.editor.cursorLeft") &&
      this.getText() === "" &&
      !this.isShowingAutocomplete()
    ) {
      Array.from(this.hooks.emptyLeft).forEach((handler) => {
        handler();
      });
      return;
    }

    super.handleInput(data);
  }
}

type EditorHooksUi = Pick<HostUi, "setEditorFrame" | "onEmptyEditorLeft" | "captureEditorKeys">;

export const createEditorHooks = (tuiCtx: () => ExtensionContext | undefined): EditorHooksUi => {
  const hooks: EditorHooks = { emptyLeft: new Set() };
  let installed: EditorFactory;

  const ensureInstalled = () => {
    const ctx = tuiCtx();

    if (!ctx) {
      return false;
    }

    const active = ctx.ui.getEditorComponent();

    if (active && active !== installed) {
      return false;
    }

    if (!active) {
      installed = (tui, theme, keybindings) => new HostEditor(tui, theme, keybindings, hooks);
      ctx.ui.setEditorComponent(installed);
    }

    return true;
  };

  const releaseIfUnused = () => {
    const ctx = tuiCtx();

    if (!ctx || hooks.frame || hooks.emptyLeft.size > 0 || hooks.capture || !installed) {
      return;
    }

    if (ctx.ui.getEditorComponent() === installed) {
      ctx.ui.setEditorComponent(undefined);
    }

    installed = undefined;
  };

  return {
    setEditorFrame: (frame) => {
      hooks.frame = frame;

      if (frame) {
        ensureInstalled();
        return;
      }

      releaseIfUnused();
    },
    onEmptyEditorLeft: (handler) => {
      if (!ensureInstalled()) {
        return () => {};
      }

      const entry = () => handler();

      hooks.emptyLeft.add(entry);

      return () => {
        hooks.emptyLeft.delete(entry);
        releaseIfUnused();
      };
    },
    captureEditorKeys: (handler) => {
      if (!ensureInstalled()) {
        return () => {};
      }

      hooks.capture = handler;

      return () => {
        if (hooks.capture === handler) {
          hooks.capture = undefined;
        }

        releaseIfUnused();
      };
    },
  };
};
