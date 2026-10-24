import { stripVTControlCharacters } from "node:util";
import {
  parseSessionLines,
  promptRecordEntry,
  realOverlayParts,
} from "../../../../core/test/adapter/offline.ts";
import { type FakeHost, plainTheme, taggedTheme } from "../../../../core/test/helpers/fakes.ts";
import type {
  AnyToolSpec,
  KeyPress,
  OverlayApi,
  ThemeLike,
  ViewComponent,
} from "../../../../pi-adapter/index.ts";
import { NAMESPACE } from "../../src/model/paths.ts";

export const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

export const key = (name: KeyPress["name"], char?: string): KeyPress => ({ name, char });

export { char } from "../../../../core/test/helpers/keys.ts";

export const fakeOverlayApi = (
  rows = 200,
  theme: ThemeLike = plainTheme,
  host?: { tools: Map<string, unknown> },
) => {
  const state = { closed: false, renders: 0 };
  const transcripts: { owner?: string }[] = [];

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
    createTranscript: (options) => {
      transcripts.push(options ?? {});

      return parts.createTranscript({
        tools: [...(host?.tools.values() ?? [])] as AnyToolSpec[],
        owner: options?.owner,
      });
    },
    createScroll: parts.createScroll,
  };

  return { api, state, transcripts };
};

const opened: ViewComponent[] = [];

export const openLastOverlay = (host: FakeHost, rows = 200, theme: ThemeLike = plainTheme) => {
  const factory = host.overlays.at(-1);

  if (!factory) {
    throw new Error("no overlay opened");
  }

  const { api, state, transcripts } = fakeOverlayApi(rows, theme, host);
  const view = factory(api);

  opened.push(view);

  return { view, state, transcripts, lines: (width = 100) => plain(view.render(width)) };
};

export const disposeOverlays = () => {
  opened.splice(0).forEach((view) => {
    view.dispose?.();
  });
};

export const selectedRow = (lines: string[]) => lines.find((line) => line.startsWith(" › "));

export const recordingTheme: ThemeLike = {
  ...taggedTheme(),
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
