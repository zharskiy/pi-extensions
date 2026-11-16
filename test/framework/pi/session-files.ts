import { readFileSync } from "node:fs";
import { messageText } from "../../../platform/pi-adapter/runtime/message-text.ts";
import {
  readSessionEntries,
  replaySystemMessages,
} from "../../../platform/pi-adapter/runtime/session-file.ts";
import { sessionEvents } from "./live/session-events.ts";

export {
  parseSessionLines,
  promptRecordEntry,
  readSessionFile,
} from "../../../platform/pi-adapter/runtime/session-file.ts";

type RawMessage = { role?: string; content?: unknown; toolName?: string; details?: unknown };

export const sessionFacts = (file: string) => {
  const messages = (readSessionEntries(file) as { type?: string; message?: RawMessage }[])
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => entry.message as RawMessage);

  const events = sessionEvents(messages);
  const calls = events.flatMap((event) => (event.type === "tool_call" ? [event.name] : []));

  const results = messages
    .filter((message) => message.role === "toolResult")
    .map((message) => ({
      toolName: message.toolName ?? "tool",
      text: messageText(message.content),
      details: message.details,
    }));

  return { tools: [...replaySystemMessages(messages).tools.keys()], events, calls, results };
};

type SessionLine = { type?: string; parentSession?: string; message?: { role?: string; content?: unknown } };

export const sessionLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionLine);

export const sessionHeader = (file: string) => sessionLines(file).find((line) => line.type === "session");
