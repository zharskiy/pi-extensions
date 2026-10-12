import type { AgentDefinition } from "../../model/types.ts";

const OUTPUT_CONTRACT =
  "Output: your last message is your result. Make it complete and self-contained; your caller sees nothing else.";

export const assemblePromptAppend = (basePrompt: string, definition: AgentDefinition): string[] => {
  const agentSection = [`# Agent: ${definition.name}`, definition.prompt, OUTPUT_CONTRACT]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return [basePrompt.trim(), agentSection];
};
