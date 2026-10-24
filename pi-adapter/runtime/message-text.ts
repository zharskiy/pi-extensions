import type { RoutedMessage } from "../types/contract.ts";

export const contentParts = (content: unknown) => (Array.isArray(content) ? content : []);

export const messageText = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }

  return contentParts(content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
};

export const toolCallCount = (content: unknown) =>
  contentParts(content).filter((part) => part.type === "toolCall").length;

type RawMessage = { role?: string; content?: unknown };

type RawEntry = { type?: string; message?: RawMessage };

const endsRun = (message: RawMessage) => message.role === "assistant" && toolCallCount(message.content) === 0;

type RunWalk = { texts: string[]; userAfter: boolean; done: boolean };

const step = (walk: RunWalk, entry: RawEntry): RunWalk => {
  const message = entry.type === "message" ? entry.message : undefined;

  if (walk.done || message === undefined) {
    return walk;
  }

  if (walk.userAfter && endsRun(message)) {
    walk.done = true;
    return walk;
  }

  walk.userAfter = message.role === "user";

  const text = message.role === "assistant" ? messageText(message.content).trim() : "";

  if (text.length > 0) {
    walk.texts.push(text);
  }

  return walk;
};

export const finalRunTexts = (entries: readonly unknown[]): string[] =>
  (entries as RawEntry[]).reduceRight(step, { texts: [], userAfter: false, done: false }).texts.reverse();

export const formatRoutedMessage = ({ sender, text }: RoutedMessage) => `[message from ${sender}]\n${text}`;
