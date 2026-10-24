import type { AgentDefinition } from "../model/agent-record.ts";

export const assemblePromptAppend = (basePrompt: string, definition: AgentDefinition): string[] => {
  const agentSection = [`# Agent: ${definition.name}`, definition.prompt]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return [basePrompt.trim(), agentSection];
};
