import type { AgentDefinition } from "../../model/types.ts";

const outputContract = (definition: AgentDefinition) => {
  if (definition.output === "file") {
    return "Output: write your full result to the result file path given in your task, then reply with one line naming that path.";
  }

  return "Output: your last message is your result. Make it complete and self-contained; your caller sees nothing else.";
};

export const assemblePromptAppend = (basePrompt: string, definition: AgentDefinition): string[] => {
  const agentSection = [`# Agent: ${definition.name}`, definition.prompt, outputContract(definition)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return [basePrompt.trim(), agentSection];
};
