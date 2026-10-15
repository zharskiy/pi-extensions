import { stripVTControlCharacters } from "node:util";
import type { AnyToolSpec, KeyPress, OverlayApi, ThemeLike } from "../../../../core/adapter/contract.ts";
import {
  parseSessionLines,
  promptRecordEntry,
  realOverlayParts,
} from "../../../../core/test/adapter/offline.ts";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import { NAMESPACE } from "../../src/model/paths.ts";

export const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

export const key = (name: KeyPress["name"], char?: string): KeyPress => ({ name, char });

export const char = (value: string): KeyPress => ({ name: "other", char: value });

export const fakeOverlayApi = (rows = 200, theme: ThemeLike = plainTheme) => {
  const state = { closed: false, renders: 0 };
  const transcripts: { tools?: AnyToolSpec[] }[] = [];

  const requestRender = () => {
    state.renders += 1;
  };
  const parts = realOverlayParts(requestRender);

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

      return parts.createTranscript(options);
    },
    createScroll: parts.createScroll,
  };

  return { api, state, transcripts };
};

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
