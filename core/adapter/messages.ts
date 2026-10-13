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
