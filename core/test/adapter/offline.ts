import type { TranscriptPane } from "../../adapter/contract.ts";
import { contentParts, messageText } from "../../adapter/messages.ts";
import { createTranscriptPane, type TranscriptPaneOptions } from "../../adapter/pi-transcript.ts";
import { createScrollPane } from "../../adapter/pi-ui.ts";
import { readSessionEntries, replaySystemMessages } from "../../adapter/session-file.ts";

export { formatRoutedMessage } from "../../adapter/route.ts";
export { parseSessionLines, promptRecordEntry, readSessionFile } from "../../adapter/session-file.ts";

export const realOverlayParts = (requestRender: () => void) => ({
  createTranscript: (options?: TranscriptPaneOptions): TranscriptPane =>
    createTranscriptPane({ requestRender } as never, "/repo", options),
  createScroll: () => createScrollPane(requestRender),
});

type RawMessage = { role?: string; content?: unknown; toolName?: string; details?: unknown };

export const sessionFacts = (file: string) => {
  const messages = (readSessionEntries(file) as { type?: string; message?: RawMessage }[])
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => entry.message as RawMessage);

  const calls = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => contentParts(message.content))
    .filter((part) => part.type === "toolCall")
    .map((part) => (part.name as string | undefined) ?? "tool");

  const results = messages
    .filter((message) => message.role === "toolResult")
    .map((message) => ({
      toolName: message.toolName ?? "tool",
      text: messageText(message.content),
      details: message.details,
    }));

  return { tools: [...replaySystemMessages(messages).tools.keys()], calls, results };
};
