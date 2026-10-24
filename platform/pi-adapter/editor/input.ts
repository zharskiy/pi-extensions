import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, type Component, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import type { EditorUi } from "../types/host-ui.ts";

type EditorInput = Pick<EditorUi, "onEditorSubmit" | "mapCommandCompletion" | "submitEditor">;

type FocusedTui = TUI & { getFocusedComponent(): Component | null };

type Submittable = Component & { getText?(): string; onSubmit?(text: string): void };

const CAPTURE_KEY = "pi-editor-input";

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const captureTui = (ctx: ExtensionContext) => {
  let captured: FocusedTui | undefined;

  ctx.ui.setWidget(CAPTURE_KEY, (tui) => {
    captured = tui as FocusedTui;

    return { render: () => [], invalidate: () => {} };
  });
  ctx.ui.setWidget(CAPTURE_KEY, undefined);

  return captured;
};

const withCommandMapping = (
  current: AutocompleteProvider,
  map: (command: string) => string | undefined,
): AutocompleteProvider => ({
  triggerCharacters: current.triggerCharacters,
  getSuggestions: (lines, cursorLine, cursorCol, options) =>
    current.getSuggestions(lines, cursorLine, cursorCol, options),
  applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
    const target = prefix.startsWith("/") ? map(`/${item.value}`) : undefined;
    const mapped = target ? { ...item, value: target.replace(/^\//, "") } : item;

    return current.applyCompletion(lines, cursorLine, cursorCol, mapped, prefix);
  },
  shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
});

export const createEditorInput = (tuiCtx: () => ExtensionContext | undefined): EditorInput => ({
  onEditorSubmit: (rewrite) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return () => {};
    }

    return ctx.ui.onTerminalInput((data) => {
      if (!getKeybindings().matches(data, "tui.input.submit")) {
        return undefined;
      }

      const replacement = rewrite(ctx.ui.getEditorText());

      if (replacement !== undefined) {
        ctx.ui.setEditorText(replacement);
      }

      return undefined;
    });
  },
  mapCommandCompletion: (map) => {
    tuiCtx()?.ui.addAutocompleteProvider((current) => withCommandMapping(current, map));
  },
  submitEditor: async (text) => {
    await nextMacrotask();

    const ctx = tuiCtx();

    if (!ctx) {
      return false;
    }

    ctx.ui.setEditorText(text);

    const editor = captureTui(ctx)?.getFocusedComponent() as Submittable | null | undefined;

    if (editor?.getText?.() !== text || !editor.onSubmit) {
      return false;
    }

    editor.onSubmit(text);

    return true;
  },
});
