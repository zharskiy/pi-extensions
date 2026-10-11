import { readFileSync } from "node:fs";
import type { PromptRecord, PromptSection, PromptTool, SessionRecord, TranscriptItem } from "./contract.ts";

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

export type PromptRecordData = {
  skills?: { name: string; description: string }[];
  guidelines?: string[];
  providerPayload?: unknown;
  model?: string;
};

const textOf = (content: string | ContentPart[] | undefined) => {
  if (typeof content === "string") {
    return content;
  }

  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
};

type Replay = { sections: Map<string, string>; tools: Map<string, PromptTool> };

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

const transcriptItem = (entry: RawEntry): TranscriptItem | undefined => {
  if (entry.type === "custom_message") {
    return {
      kind: "custom",
      customType: entry.customType ?? "custom",
      text: textOf(entry.content),
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
    return { kind: "user", text: textOf(message.content) };
  }

  if (message.role === "toolResult") {
    return {
      kind: "tool",
      toolName: message.toolName ?? "tool",
      toolCallId: message.toolCallId ?? "",
      text: textOf(message.content),
      isError: message.isError === true,
      raw: message,
    };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  const parts = Array.isArray(message.content) ? message.content : [];

  const thinking = parts
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking ?? "")
    .join("\n");

  const toolCalls = parts
    .filter((part) => part.type === "toolCall")
    .map((part) => ({ name: part.name ?? "tool", args: part.arguments }));

  return {
    kind: "assistant",
    text: textOf(message.content),
    thinking: thinking || undefined,
    toolCalls,
    raw: message,
  };
};

export const parseSessionLines = (lines: readonly string[], recordEntry: string): SessionRecord => {
  const entries = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RawEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is RawEntry => entry !== undefined);

  const replay: Replay = { sections: new Map(), tools: new Map() };

  entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "system")
    .forEach((entry) => {
      replaySystemMessage(replay, entry.message as RawMessage);
    });

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

  return { prompt, items };
};

export const readSessionFile = (file: string, recordEntry: string): SessionRecord =>
  parseSessionLines(readFileSync(file, "utf8").split("\n"), recordEntry);
