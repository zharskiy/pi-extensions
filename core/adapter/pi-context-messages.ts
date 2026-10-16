import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ContextMessage, MessageBlock } from "./contract.ts";

type Message = Parameters<typeof estimateTokens>[0];

type Block = { type?: string };

const blocksOf = (message: Message): MessageBlock[] => {
  if (message.role !== "assistant") {
    return [];
  }

  return (message.content as Block[]).map((block) => ({
    type: block.type ?? "text",
    tokens: estimateTokens({ ...message, content: [block] } as Message),
  }));
};

export const messageFacts = (messages: readonly unknown[]): ContextMessage[] =>
  (messages as Message[])
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, tokens: estimateTokens(message), blocks: blocksOf(message) }));
