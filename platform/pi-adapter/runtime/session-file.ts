import { readFileSync } from "node:fs";
import {
  calculateContextTokens,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type { PromptTool, SessionRecord } from "../types/messages.ts";
import type { TranscriptItem } from "../types/view.ts";
import { messageText } from "./message-text.ts";

export const promptRecordEntry = (namespace: string) => `${namespace}:prompt-record`;

type ContentPart = { type?: string; text?: string };

type RawMessage = {
  role?: string;
  toolCallId?: string;
  content?: string | ContentPart[];
  sections?: Record<string, string | null>;
  toolsAdded?: PromptTool[];
  toolsRemoved?: { name: string }[];
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

type PromptRecordData = { providerPayload?: unknown };

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
    return { kind: "tool", toolCallId: message.toolCallId ?? "", raw: message };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  return { kind: "assistant", raw: message };
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

  const recordData = entries
    .filter((entry) => entry.type === "custom" && entry.customType === recordEntry)
    .map((entry) => entry.data as PromptRecordData)
    .at(-1);

  const items = entries.map(transcriptItem).filter((item): item is TranscriptItem => item !== undefined);

  const contextTokens = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => measuredContext(entry.message))
    .filter((tokens) => tokens !== undefined)
    .at(-1);

  return { providerPayload: recordData?.providerPayload, items, contextTokens };
};

export const readSessionFile = (file: string, recordEntry: string): SessionRecord =>
  parseSessionLines(readLines(file), recordEntry);

type PathEntry = RawEntry & { id?: string; parentId?: string | null };

type CustomEntryData = { customType: string; data: unknown };

export type SessionPath = { items: TranscriptItem[]; customEntries: CustomEntryData[] };

export const readSessionTree = (file: string): PathEntry[] => {
  const entries = parseSessionEntries(readFileSync(file, "utf8"));

  migrateSessionEntries(entries);

  return entries as PathEntry[];
};

const pathTo = (entries: readonly PathEntry[], leafId: string | null): PathEntry[] => {
  const walk = entries.reduceRight(
    (state, entry) => {
      if (entry.id === undefined || entry.id !== state.next) {
        return state;
      }

      state.path.push(entry);

      return { next: entry.parentId ?? null, path: state.path };
    },
    { next: leafId, path: [] as PathEntry[] },
  );

  return walk.path.reverse();
};

export const sessionPath = (entries: readonly PathEntry[], leafId: string | null): SessionPath => {
  const path = pathTo(entries, leafId);

  const items = path.map(transcriptItem).filter((item): item is TranscriptItem => item !== undefined);

  const customEntries = path
    .filter((entry) => entry.type === "custom")
    .map((entry) => ({ customType: entry.customType ?? "", data: entry.data }));

  return { items, customEntries };
};
