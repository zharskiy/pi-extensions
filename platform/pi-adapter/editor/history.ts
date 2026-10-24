import type {
  CustomEditor,
  ExtensionContext,
  SessionEntry,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export type HistoryRecord = { history?: string[]; seed?: string[] };

export type EditorHistory = { attach(editor: CustomEditor): void };

type Recall = { history: string[] };

const SEEDED_REASONS: ReadonlySet<SessionStartEvent["reason"]> = new Set(["resume", "fork"]);

const userText = (entry: SessionEntry) => {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return "";
  }

  const content = entry.message.content;

  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
};

export const seedHistory = (
  record: HistoryRecord,
  reason: SessionStartEvent["reason"],
  ctx: ExtensionContext,
) => {
  record.seed = SEEDED_REASONS.has(reason)
    ? ctx.sessionManager.buildContextEntries().map(userText).filter(Boolean)
    : undefined;
};

export const takeHistory = (record: HistoryRecord): EditorHistory => {
  record.history ??= [];

  const history = record.history;
  const seed = record.seed ?? [];

  record.seed = undefined;

  return {
    attach: (editor) => {
      (editor as unknown as Recall).history = history;
      seed.splice(0).forEach((text) => {
        editor.addToHistory(text);
      });
    },
  };
};
