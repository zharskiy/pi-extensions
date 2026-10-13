import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { EditorFrame, HostUi } from "./contract.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

class FramedEditor extends CustomEditor {
  private readonly frame: EditorFrame;
  private bottomBorder = "";
  private scrolled = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, frame: EditorFrame) {
    super(tui, theme, keybindings);
    this.frame = frame;
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
    if (width < this.frame.minWidth) {
      return super.render(width);
    }

    const lines = super.render(width - this.frame.chrome);
    const bottom = lines.indexOf(this.bottomBorder, 1);

    return this.frame.decorate(lines, { bottom, scrolled: this.scrolled }, this.borderColor);
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.width < this.frame.minWidth) {
      return super.handleMouse(event);
    }

    return super.handleMouse({
      ...event,
      x: Math.max(0, event.x - this.frame.left),
      width: event.width - this.frame.chrome,
    });
  }
}

export const createEditorFrame = (tuiCtx: () => ExtensionContext | undefined): HostUi["setEditorFrame"] => {
  let installed: EditorFactory;

  return (frame) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return;
    }

    const active = ctx.ui.getEditorComponent();

    if (active && active !== installed) {
      return;
    }

    installed = frame && ((tui, theme, keybindings) => new FramedEditor(tui, theme, keybindings, frame));
    ctx.ui.setEditorComponent(installed);
  };
};
