import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { EditorFrame, EditorKeyHandler, HostUi } from "./contract.ts";
import { keyPress } from "./pi-keys.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

type SharedEditor = {
  frame?: EditorFrame;
  emptyLeft: Set<() => void>;
  emptyDown: Set<() => void>;
  capture?: EditorKeyHandler;
  installed?: EditorFactory;
};

const EDITOR_KEY = Symbol.for("pi-extensions.editor-hooks");

const shared = globalThis as typeof globalThis & { [EDITOR_KEY]?: SharedEditor };

const sharedEditor = (): SharedEditor =>
  (shared[EDITOR_KEY] ??= { emptyLeft: new Set(), emptyDown: new Set() });

type EditorPending = { jumpMode: "forward" | "backward" | null; isInPaste: boolean };

type EmptyKey = "emptyLeft" | "emptyDown";

class HostEditor extends CustomEditor {
  private readonly keys: KeybindingsManager;
  private readonly hooks: SharedEditor;
  private bottomBorder = "";
  private scrolled = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: SharedEditor) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
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

  private fire(key: EmptyKey) {
    Array.from(this.hooks[key]).forEach((handler) => {
      handler();
    });
  }

  handleInput(data: string) {
    const capture = this.hooks.capture;

    if (capture) {
      if (capture(keyPress(data, this.keys)) === "consumed") {
        return;
      }

      if (this.hooks.capture === capture) {
        this.hooks.capture = undefined;
      }
    }

    const idle = !this.pendingKeyState() && this.getText() === "" && !this.isShowingAutocomplete();

    if (idle && this.hooks.emptyLeft.size > 0 && this.keys.matches(data, "tui.editor.cursorLeft")) {
      this.fire("emptyLeft");
      return;
    }

    if (idle && this.hooks.emptyDown.size > 0 && this.keys.matches(data, "tui.editor.cursorDown")) {
      this.fire("emptyDown");
      return;
    }

    super.handleInput(data);
  }
}

type EditorHooksUi = Pick<
  HostUi,
  "setEditorFrame" | "onEmptyEditorLeft" | "onEmptyEditorDown" | "captureEditorKeys"
>;

export type EditorHooks = EditorHooksUi & { sync(): void; release(): void };

export const createEditorHooks = (tuiCtx: () => ExtensionContext | undefined): EditorHooks => {
  const own: Omit<SharedEditor, "installed"> = { emptyLeft: new Set(), emptyDown: new Set() };

  const inUse = (hooks: SharedEditor) =>
    Boolean(hooks.frame || hooks.emptyLeft.size > 0 || hooks.emptyDown.size > 0 || hooks.capture);

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

  const onEmptyKey = (key: EmptyKey, handler: () => void) => {
    const entry = () => handler();

    sharedEditor()[key].add(entry);
    own[key].add(entry);
    ensureInstalled();

    return () => {
      sharedEditor()[key].delete(entry);
      own[key].delete(entry);
      releaseIfUnused();
    };
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
    onEmptyEditorLeft: (handler) => onEmptyKey("emptyLeft", handler),
    onEmptyEditorDown: (handler) => onEmptyKey("emptyDown", handler),
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

      (["emptyLeft", "emptyDown"] as const).forEach((key) => {
        own[key].forEach((entry) => {
          hooks[key].delete(entry);
        });
        own[key].clear();
      });

      if (own.capture) {
        dropCapture(own.capture);
      }

      releaseIfUnused();
    },
  };
};
