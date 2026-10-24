import type { TranscriptPane } from "../../../pi-adapter/index.ts";
import { contentParts, messageText } from "../../../pi-adapter/runtime/messages.ts";
import { readSessionEntries, replaySystemMessages } from "../../../pi-adapter/runtime/session-file.ts";
import { createTranscriptPane, type TranscriptPaneOptions } from "../../../pi-adapter/tools/pi-transcript.ts";
import { createScrollPane } from "../../../pi-adapter/ui/pi-ui.ts";

export { formatRoutedMessage } from "../../../pi-adapter/index.ts";
export {
  parseSessionLines,
  promptRecordEntry,
  readSessionFile,
} from "../../../pi-adapter/runtime/session-file.ts";

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
