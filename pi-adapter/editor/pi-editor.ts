import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
  type SessionStartEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { shared } from "../runtime/pi-shared.ts";
import { themeLike } from "../tools/pi-tools.ts";
import type { EditorFrame, EditorKeyHandler, HostUi } from "../types/contract.ts";
import { keyPress } from "../ui/pi-keys.ts";
import { type EditorHistory, type HistoryRecord, seedHistory, takeHistory } from "./pi-editor-history.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

type SharedEditor = HistoryRecord & {
  frame?: EditorFrame;
  frameTheme?: () => Theme | undefined;
  emptyLeft: Set<() => void>;
  emptyDown: Set<() => void>;
  emptyEscape: Set<() => boolean>;
  capture?: EditorKeyHandler;
  installed?: EditorFactory;
};

const sharedEditor = (): SharedEditor => {
  const hooks = shared<Partial<SharedEditor>>("editor-hooks", () => ({}));

  hooks.emptyLeft ??= new Set();
  hooks.emptyDown ??= new Set();
  hooks.emptyEscape ??= new Set();

  return hooks as SharedEditor;
};

type EditorPending = { jumpMode: "forward" | "backward" | null; isInPaste: boolean };

type EmptyKey = "emptyLeft" | "emptyDown";

class HostEditor extends CustomEditor {
  private readonly keys: KeybindingsManager;
  private readonly hooks: SharedEditor;
  private bottomBorder = "";
  private scrolled = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    hooks: SharedEditor,
    history: EditorHistory,
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.keys = keybindings;
    this.hooks = hooks;
    history.attach(this);
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
    const theme = this.hooks.frameTheme?.();

    if (!frame || !theme || width < frame.minWidth) {
      return super.render(width);
    }

    const lines = super.render(width - frame.chrome);
    const bottom = lines.indexOf(this.bottomBorder, 1);

    return frame.decorate(lines, { bottom, scrolled: this.scrolled }, this.borderColor, themeLike(theme));
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

  private escapeConsumed() {
    return Array.from(this.hooks.emptyEscape).some((handler) => handler());
  }

  handleInput(data: string) {
    const key = keyPress(data, this.keys);
    const capture = this.hooks.capture;

    if (capture) {
      if (capture(key) === "consumed") {
        return;
      }

      if (this.hooks.capture === capture) {
        this.hooks.capture = undefined;
      }
    }

    const idle = !this.pendingKeyState() && this.getText() === "" && !this.isShowingAutocomplete();

    if (idle && this.hooks.emptyLeft.size > 0 && key.name === "left") {
      this.fire("emptyLeft");
      return;
    }

    if (idle && this.hooks.emptyDown.size > 0 && key.name === "down") {
      this.fire("emptyDown");
      return;
    }

    if (
      idle &&
      this.hooks.emptyEscape.size > 0 &&
      this.keys.matches(data, "app.interrupt") &&
      this.escapeConsumed()
    ) {
      return;
    }

    super.handleInput(data);
  }
}

type EditorHooksUi = Pick<
  HostUi,
  "setEditorFrame" | "onEmptyEditorLeft" | "onEmptyEditorDown" | "onEmptyEditorEscape" | "captureEditorKeys"
>;

export type EditorHooks = EditorHooksUi & {
  sync(reason: SessionStartEvent["reason"]): void;
  release(): void;
};

export const createEditorHooks = (tuiCtx: () => ExtensionContext | undefined): EditorHooks => {
  const own: Pick<SharedEditor, "frame" | "emptyLeft" | "emptyDown" | "emptyEscape" | "capture"> = {
    emptyLeft: new Set(),
    emptyDown: new Set(),
    emptyEscape: new Set(),
  };

  const inUse = (hooks: SharedEditor) =>
    Boolean(
      hooks.frame ||
        hooks.emptyLeft.size > 0 ||
        hooks.emptyDown.size > 0 ||
        hooks.emptyEscape.size > 0 ||
        hooks.capture,
    );

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
      const history = takeHistory(hooks);

      hooks.installed = (tui, theme, keybindings) => new HostEditor(tui, theme, keybindings, hooks, history);
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

  const addHook = <H>(pick: (hooks: Pick<SharedEditor, EmptyKey | "emptyEscape">) => Set<H>, entry: H) => {
    pick(sharedEditor()).add(entry);
    pick(own).add(entry);
    ensureInstalled();

    return () => {
      pick(sharedEditor()).delete(entry);
      pick(own).delete(entry);
      releaseIfUnused();
    };
  };

  const onEmptyKey = (key: EmptyKey, handler: () => void) =>
    addHook(
      (hooks) => hooks[key],
      () => handler(),
    );

  const onEmptyEscape = (handler: () => boolean) =>
    addHook(
      (hooks) => hooks.emptyEscape,
      () => tuiCtx()?.isIdle() === true && handler(),
    );

  return {
    setEditorFrame: (frame) => {
      const hooks = sharedEditor();

      if (frame) {
        hooks.frame = frame;
        hooks.frameTheme = () => tuiCtx()?.ui.theme;
        own.frame = frame;
        ensureInstalled();
        return;
      }

      if (hooks.frame === own.frame) {
        hooks.frame = undefined;
        hooks.frameTheme = undefined;
      }

      own.frame = undefined;
      releaseIfUnused();
    },
    onEmptyEditorLeft: (handler) => onEmptyKey("emptyLeft", handler),
    onEmptyEditorDown: (handler) => onEmptyKey("emptyDown", handler),
    onEmptyEditorEscape: onEmptyEscape,
    captureEditorKeys: (handler) => {
      sharedEditor().capture = handler;
      own.capture = handler;
      ensureInstalled();

      return () => {
        dropCapture(handler);
        releaseIfUnused();
      };
    },
    sync: (reason) => {
      const ctx = tuiCtx();
      const hooks = sharedEditor();

      if (ctx && !ctx.ui.getEditorComponent()) {
        seedHistory(hooks, reason, ctx);
      }

      if (inUse(hooks)) {
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

      own.emptyEscape.forEach((entry) => {
        hooks.emptyEscape.delete(entry);
      });
      own.emptyEscape.clear();

      if (own.capture) {
        dropCapture(own.capture);
      }

      releaseIfUnused();
    },
  };
};
