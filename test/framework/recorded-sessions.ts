const messageLine = (message: Record<string, unknown>) => JSON.stringify({ type: "message", message });

export const userLine = (text: string) => messageLine({ role: "user", content: [{ type: "text", text }] });

export const assistantToolCallLine = (id: string, name: string, args: unknown) =>
  messageLine({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
  });

export const toolResultLine = (id: string, name: string, text: string) =>
  messageLine({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    details: {},
    isError: false,
  });

export const customLine = (customType: string, data: unknown) =>
  JSON.stringify({ type: "custom", customType, data });
