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

export const finalRunTexts = (entries: readonly unknown[]): string[] => {
  const messages = (entries as RawEntry[])
    .filter((entry) => entry.type === "message" && entry.message !== undefined)
    .map((entry) => entry.message as RawMessage);

  const start = messages.findLastIndex(
    (message, index) => message.role === "user" && (index === 0 || endsRun(messages[index - 1])),
  );

  return messages
    .slice(Math.max(start, 0))
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message.content).trim())
    .filter((text) => text.length > 0);
};
