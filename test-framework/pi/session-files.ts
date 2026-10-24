import { readFileSync } from "node:fs";
import { contentParts, messageText } from "../../pi-adapter/runtime/message-text.ts";
import { readSessionEntries, replaySystemMessages } from "../../pi-adapter/runtime/session-file.ts";

export {
  parseSessionLines,
  promptRecordEntry,
  readSessionFile,
} from "../../pi-adapter/runtime/session-file.ts";

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

type SessionLine = { type?: string; parentSession?: string; message?: { role?: string; content?: unknown } };

export const sessionLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionLine);

export const sessionHeader = (file: string) => sessionLines(file).find((line) => line.type === "session");
