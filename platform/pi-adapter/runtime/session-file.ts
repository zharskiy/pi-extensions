import { readFileSync } from "node:fs";
import {
  buildContextEntries,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  sessionEntryToContextMessages,
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
};

type RawEntry = {
  id?: string;
  parentId?: string | null;
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

  return { providerPayload: recordData?.providerPayload, items };
};

export const readSessionFile = (file: string, recordEntry: string): SessionRecord =>
  parseSessionLines(readLines(file), recordEntry);

const SUMMARY_ROLES = ["compactionSummary", "branchSummary"];

const branchItems = (entry: RawEntry): TranscriptItem[] => {
  if (entry.type === "custom") {
    return [{ kind: "entry", customType: entry.customType ?? "", data: entry.data }];
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return sessionEntryToContextMessages(entry as SessionEntry)
      .filter((message) => SUMMARY_ROLES.includes(message.role))
      .map((raw) => ({ kind: "summary", raw }));
  }

  if (entry.type === "message" && entry.message?.role === "bashExecution") {
    return [{ kind: "bash", raw: entry.message }];
  }

  const item = transcriptItem(entry);

  return item ? [item] : [];
};

type SessionBranch = { items: TranscriptItem[]; custom: { customType: string; data: unknown }[] };

const leafOf = (entries: RawEntry[], byId: Map<string | undefined, RawEntry>, leafId: string | null) => {
  if (leafId === null) {
    return undefined;
  }

  return byId.get(leafId) ?? entries.at(-1);
};

const leafPath = (entries: RawEntry[], leafId: string | null) => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parentOf = (entry: RawEntry) => (entry.parentId ? byId.get(entry.parentId) : undefined);

  const step = ({ at, path }: { at?: RawEntry; path: RawEntry[] }) => {
    if (!at) {
      return { path };
    }

    path.push(at);

    return { at: parentOf(at), path };
  };

  return entries.reduce(step, { at: leafOf(entries, byId, leafId), path: [] }).path.reverse();
};

export const readSessionBranch = (file: string, leafId: string | null): SessionBranch => {
  const entries = parseSessionEntries(readFileSync(file, "utf8"));

  migrateSessionEntries(entries);

  const branch = buildContextEntries(entries as SessionEntry[], leafId) as RawEntry[];

  const custom = leafPath(entries as RawEntry[], leafId)
    .filter((entry) => entry.type === "custom")
    .map((entry) => ({ customType: entry.customType ?? "", data: entry.data }));

  return { items: branch.flatMap(branchItems), custom };
};
