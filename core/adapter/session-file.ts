import { readFileSync } from "node:fs";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type { PromptRecord, PromptSection, PromptTool, SessionRecord, TranscriptItem } from "./contract.ts";
import { contentParts, messageText } from "./messages.ts";

export const promptRecordEntry = (namespace: string) => `${namespace}:prompt-record`;

type ContentPart = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

type RawMessage = {
  role?: string;
  toolCallId?: string;
  content?: string | ContentPart[];
  sections?: Record<string, string | null>;
  toolsAdded?: PromptTool[];
  toolsRemoved?: { name: string }[];
  toolName?: string;
  isError?: boolean;
  customType?: string;
  stopReason?: string;
  usage?: Parameters<typeof calculateContextTokens>[0];
};

type RawEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: string;
  content?: string | ContentPart[];
  message?: RawMessage;
};

type PromptRecordData = {
  skills?: { name: string; description: string }[];
  guidelines?: string[];
  providerPayload?: unknown;
  model?: string;
};

export type Replay = { sections: Map<string, string>; tools: Map<string, PromptTool> };

const replaySystemMessage = (replay: Replay, message: RawMessage) => {
  Object.entries(message.sections ?? {}).forEach(([name, text]) => {
    if (text === null) {
      replay.sections.delete(name);
      return;
    }

    replay.sections.set(name, text);
  });

  (message.toolsRemoved ?? []).forEach((tool) => {
    replay.tools.delete(tool.name);
  });

  (message.toolsAdded ?? []).forEach((tool) => {
    replay.tools.set(tool.name, {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters,
    });
  });
};

export const replaySystemMessages = (messages: readonly unknown[]): Replay => {
  const replay: Replay = { sections: new Map(), tools: new Map() };

  (messages as RawMessage[])
    .filter((message) => message.role === "system")
    .forEach((message) => {
      replaySystemMessage(replay, message);
    });

  return replay;
};

const transcriptItem = (entry: RawEntry): TranscriptItem | undefined => {
  if (entry.type === "custom_message") {
    return {
      kind: "custom",
      customType: entry.customType ?? "custom",
      text: messageText(entry.content),
      raw: {
        role: "custom",
        customType: entry.customType ?? "custom",
        content: entry.content ?? "",
        display: entry.display ?? true,
        details: entry.details,
        timestamp: Date.parse(entry.timestamp ?? "") || 0,
      },
    };
  }

  const message = entry.message;

  if (entry.type !== "message" || !message) {
    return undefined;
  }

  if (message.role === "user") {
    return { kind: "user", text: messageText(message.content) };
  }

  if (message.role === "toolResult") {
    return {
      kind: "tool",
      toolName: message.toolName ?? "tool",
      toolCallId: message.toolCallId ?? "",
      text: messageText(message.content),
      isError: message.isError === true,
      raw: message,
    };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  const parts: ContentPart[] = contentParts(message.content);

  const thinking = parts
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking ?? "")
    .join("\n");

  const toolCalls = parts
    .filter((part) => part.type === "toolCall")
    .map((part) => ({ name: part.name ?? "tool", args: part.arguments }));

  return {
    kind: "assistant",
    text: messageText(message.content),
    thinking: thinking || undefined,
    toolCalls,
    raw: message,
  };
};

const measuredContext = (message: RawMessage | undefined) => {
  const usage = message?.role === "assistant" ? message.usage : undefined;
  const failed = message?.stopReason === "aborted" || message?.stopReason === "error";

  if (!usage || failed) {
    return undefined;
  }

  const tokens = calculateContextTokens(usage);

  return tokens > 0 ? tokens : undefined;
};

const parseEntries = (lines: readonly string[]): RawEntry[] =>
  lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RawEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is RawEntry => entry !== undefined);

const readLines = (file: string) => readFileSync(file, "utf8").split("\n");

export const readSessionEntries = (file: string): unknown[] => parseEntries(readLines(file));

export const parseSessionLines = (lines: readonly string[], recordEntry: string): SessionRecord => {
  const entries = parseEntries(lines);

  const replay = replaySystemMessages(
    entries.filter((entry) => entry.type === "message").map((entry) => entry.message ?? {}),
  );

  const recordData = entries
    .filter((entry) => entry.type === "custom" && entry.customType === recordEntry)
    .map((entry) => entry.data as PromptRecordData)
    .at(-1);

  const sections: PromptSection[] = Array.from(replay.sections, ([name, text]) => ({ name, text }));

  const prompt: PromptRecord = {
    sections,
    tools: Array.from(replay.tools.values()),
    skills: recordData?.skills ?? [],
    guidelines: recordData?.guidelines ?? [],
    providerPayload: recordData?.providerPayload,
    model: recordData?.model,
  };

  const items = entries.map(transcriptItem).filter((item): item is TranscriptItem => item !== undefined);

  const contextTokens = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => measuredContext(entry.message))
    .filter((tokens) => tokens !== undefined)
    .at(-1);

  return { prompt, items, contextTokens };
};

export const readSessionFile = (file: string, recordEntry: string): SessionRecord =>
  parseSessionLines(readLines(file), recordEntry);
