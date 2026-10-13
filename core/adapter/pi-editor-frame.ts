import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { EditorFrame, HostUi } from "./contract.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

class FramedEditor extends CustomEditor {
  private readonly frame: EditorFrame;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, frame: EditorFrame) {
    super(tui, theme, keybindings);
    this.frame = frame;
  }

  render(width: number): string[] {
    if (width < this.frame.minWidth) {
      return super.render(width);
    }

    return this.frame.decorate(super.render(width - this.frame.chrome), this.borderColor);
  }
}

export const createEditorFrame = (tuiCtx: () => ExtensionContext | undefined): HostUi["setEditorFrame"] => {
  let installed: EditorFactory;
  let current: EditorFrame | undefined;

  return (frame) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return false;
    }

    const active = ctx.ui.getEditorComponent();

    if (active && active !== installed) {
      return false;
    }

    if (active && frame === current) {
      return true;
    }

    current = frame;
    installed = frame && ((tui, theme, keybindings) => new FramedEditor(tui, theme, keybindings, frame));
    ctx.ui.setEditorComponent(installed);

    return true;
  };
};
