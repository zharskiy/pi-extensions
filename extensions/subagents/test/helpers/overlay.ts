import { stripVTControlCharacters } from "node:util";
import type { AnyToolSpec, KeyPress, OverlayApi, ThemeLike } from "../../../../core/adapter/contract.ts";
import { createScrollPane, createTranscriptPane } from "../../../../core/adapter/pi-ui.ts";
import { createFakeInputPane, plainTheme } from "../../../../core/test/helpers/fakes.ts";

/** Lines without escape codes and trailing spaces. */
export const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

export const key = (name: KeyPress["name"], char?: string): KeyPress => ({ name, char });

export const char = (value: string): KeyPress => ({ name: "other", char: value });

/** An overlay api over pi's real transcript and scroll panes; records closes, renders and the transcript options. */
export const fakeOverlayApi = (rows = 200, theme: ThemeLike = plainTheme) => {
  const state = { closed: false, renders: 0 };
  const transcripts: { tools?: AnyToolSpec[] }[] = [];

  const requestRender = () => {
    state.renders += 1;
  };

  const api: OverlayApi = {
    theme,
    rows: () => rows,
    close: () => {
      state.closed = true;
    },
    requestRender,
    toolsKey: "ctrl+o",
    wheelScrolling: true,
    createTranscript: (options) => {
      transcripts.push(options ?? {});

      return createTranscriptPane({ requestRender } as never, "/repo", { tools: options?.tools });
    },
    createScroll: () => createScrollPane(requestRender),
    createInput: createFakeInputPane,
  };

  return { api, state, transcripts };
};

/** Marks every painted span: `<token>text</>` and `<b>text</b>`. */
export const recordingTheme: ThemeLike = {
  fg: (token, text) => `<${token}>${text}</>`,
  bold: (text) => `<b>${text}</b>`,
};
