import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { TextInput } from "../types/view.ts";

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

export const createTextInputs = (tui: TUI, theme: Theme) => {
  const editors: Editor[] = [];
  let focused = false;

  const create = (): TextInput => {
    const editor = new Editor(tui, editorTheme(theme));

    editor.focused = focused;
    editors.push(editor);

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

  return {
    create,
    focused: () => focused,
    focus: (value: boolean) => {
      focused = value;
      editors.forEach((editor) => {
        editor.focused = value;
      });
    },
  };
};
