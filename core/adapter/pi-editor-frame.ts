import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { EditorFrame, EditorKeyHandler, HostUi } from "./contract.ts";
import { editorKeyPress } from "./pi-keys.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

/** One record for every extension of this package: pi loads each extension with its own module cache, so module state is per extension. */
type SharedEditor = {
  frame?: EditorFrame;
  emptyLeft: Set<() => void>;
  capture?: EditorKeyHandler;
  installed?: EditorFactory;
};

const EDITOR_KEY = Symbol.for("pi-extensions.editor-hooks.v1");

const shared = globalThis as typeof globalThis & { [EDITOR_KEY]?: SharedEditor };

const sharedEditor = (): SharedEditor => {
  shared[EDITOR_KEY] ??= { emptyLeft: new Set() };

  return shared[EDITOR_KEY];
};

/** pi-tui `Editor` private state (editor.d.ts) that takes a key before the cursor bindings: jump mode and bracketed paste. */
type EditorPending = { jumpMode: "forward" | "backward" | null; isInPaste: boolean };

class HostEditor extends CustomEditor {
  private readonly keys: KeybindingsManager;
  private readonly hooks: SharedEditor;
  private bottomBorder = "";
  private scrolled = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: SharedEditor) {
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

  private pendingKeyState() {
    const pending = this as unknown as EditorPending;

    return pending.jumpMode !== null || pending.isInPaste;
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
      !this.pendingKeyState() &&
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

/** `sync` installs the editor for hooks registered before the session started; `release` drops this copy's hooks at session shutdown. */
export type EditorHooks = EditorHooksUi & { sync(): void; release(): void };

export const createEditorHooks = (tuiCtx: () => ExtensionContext | undefined): EditorHooks => {
  const own: Omit<SharedEditor, "installed"> = { emptyLeft: new Set() };

  const inUse = (hooks: SharedEditor) => Boolean(hooks.frame || hooks.emptyLeft.size > 0 || hooks.capture);

  const ensureInstalled = () => {
    const ctx = tuiCtx();
    const hooks = sharedEditor();

    if (!ctx) {
      return;
    }

    const active = ctx.ui.getEditorComponent();

    if (active && active !== hooks.installed) {
      return;
    }

    if (!active) {
      hooks.installed = (tui, theme, keybindings) => new HostEditor(tui, theme, keybindings, hooks);
      ctx.ui.setEditorComponent(hooks.installed);
    }
  };

  const releaseIfUnused = () => {
    const ctx = tuiCtx();
    const hooks = sharedEditor();

    if (!ctx || inUse(hooks) || !hooks.installed) {
      return;
    }

    if (ctx.ui.getEditorComponent() === hooks.installed) {
      ctx.ui.setEditorComponent(undefined);
    }

    hooks.installed = undefined;
  };

  const dropCapture = (handler: EditorKeyHandler) => {
    const hooks = sharedEditor();

    if (hooks.capture === handler) {
      hooks.capture = undefined;
    }

    if (own.capture === handler) {
      own.capture = undefined;
    }
  };

  return {
    setEditorFrame: (frame) => {
      const hooks = sharedEditor();

      if (frame) {
        hooks.frame = frame;
        own.frame = frame;
        ensureInstalled();
        return;
      }

      if (hooks.frame === own.frame) {
        hooks.frame = undefined;
      }

      own.frame = undefined;
      releaseIfUnused();
    },
    onEmptyEditorLeft: (handler) => {
      const entry = () => handler();

      sharedEditor().emptyLeft.add(entry);
      own.emptyLeft.add(entry);
      ensureInstalled();

      return () => {
        sharedEditor().emptyLeft.delete(entry);
        own.emptyLeft.delete(entry);
        releaseIfUnused();
      };
    },
    captureEditorKeys: (handler) => {
      sharedEditor().capture = handler;
      own.capture = handler;
      ensureInstalled();

      return () => {
        dropCapture(handler);
        releaseIfUnused();
      };
    },
    sync: () => {
      if (inUse(sharedEditor())) {
        ensureInstalled();
      }
    },
    release: () => {
      const hooks = sharedEditor();

      if (own.frame && hooks.frame === own.frame) {
        hooks.frame = undefined;
      }

      own.frame = undefined;

      own.emptyLeft.forEach((entry) => {
        hooks.emptyLeft.delete(entry);
      });
      own.emptyLeft.clear();

      if (own.capture) {
        dropCapture(own.capture);
      }

      releaseIfUnused();
    },
  };
};
