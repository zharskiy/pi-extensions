import { stripVTControlCharacters } from "node:util";
import type { AnyToolSpec, KeyPress, OverlayApi, ThemeLike } from "../../../../core/adapter/contract.ts";
import { createScrollPane, createTranscriptPane } from "../../../../core/adapter/pi-ui.ts";
import { parseSessionLines, promptRecordEntry } from "../../../../core/adapter/session-file.ts";
import { createFakeInputPane, plainTheme } from "../../../../core/test/helpers/fakes.ts";
import { NAMESPACE } from "../../src/model/paths.ts";

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

const message = (body: Record<string, unknown>) => JSON.stringify({ type: "message", message: body });

const grepCall = (id: string, pattern: string) =>
  message({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "grep", arguments: { pattern, path: "src" } }],
    stopReason: "toolUse",
  });

const grepResult = (id: string, pattern: string) =>
  message({
    role: "toolResult",
    toolCallId: id,
    toolName: "grep",
    content: [
      {
        type: "text",
        text: Array.from(
          { length: 40 },
          (_, index) => `src/${pattern}.ts:${index}: ${pattern} ${index}`,
        ).join("\n"),
      },
    ],
    details: {},
    isError: false,
  });

/** A session with a recorded request and two finished grep calls of 40 result lines each, `alpha` then `beta`. */
export const grepSession = () =>
  parseSessionLines(
    [
      message({
        role: "user",
        content: [{ type: "text", text: "Task from main (agent id explorer-1): Find" }],
      }),
      JSON.stringify({
        type: "custom",
        customType: promptRecordEntry(NAMESPACE),
        data: { providerPayload: { messages: [{ role: "user", content: "Find" }] } },
      }),
      grepCall("g1", "alpha"),
      grepResult("g1", "alpha"),
      grepCall("g2", "beta"),
      grepResult("g2", "beta"),
    ],
    promptRecordEntry(NAMESPACE),
  );
