import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { contentParts, messageText } from "../../../pi-adapter/runtime/messages.ts";
import type { RunEvent, RunRecord } from "../../eval-runs/run-record.ts";

type SessionMessage = { role?: string; content?: unknown; toolName?: string; isError?: boolean };

const assistantEvents = (message: SessionMessage): RunEvent[] => {
  const text = messageText(message.content);
  const calls = contentParts(message.content)
    .filter((part) => part.type === "toolCall")
    .map(
      (part): RunEvent => ({
        type: "tool_call",
        name: String(part.name ?? "tool"),
        arguments: part.arguments,
      }),
    );

  return [...(text === "" ? [] : [{ type: "message" as const, role: "assistant", text }]), ...calls];
};

const messageEvents = (message: SessionMessage): RunEvent[] => {
  if (message.role === "assistant") {
    return assistantEvents(message);
  }

  if (message.role === "toolResult") {
    return [
      {
        type: "tool_result",
        name: message.toolName ?? "tool",
        text: messageText(message.content),
        isError: message.isError === true,
      },
    ];
  }

  return [{ type: "message", role: message.role ?? "unknown", text: messageText(message.content) }];
};

export const sessionEvents = (messages: readonly unknown[]): RunEvent[] =>
  messages.flatMap((message) => messageEvents(message as SessionMessage));

const hasPricing = (session: Pick<AgentSession, "model">) => {
  const cost = session.model?.cost;

  return cost !== undefined && (cost.input > 0 || cost.output > 0);
};

export const runUsage = (session: Pick<AgentSession, "getSessionStats" | "model">): RunRecord["usage"] => {
  const stats = session.getSessionStats();
  const counts = {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    toolCalls: stats.toolCalls,
  };

  return hasPricing(session) ? { ...counts, costUsd: stats.cost } : counts;
};
