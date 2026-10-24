export type ContextSnapshot = { tokens: number | null; window: number; percent: number | null };

export type PromptTokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

export type ContextSection = { name: string; text: string };

export type ToolSource = "builtin" | "mcp" | "extension";

export type ContextTool = { name: string; source: ToolSource; onDemand: boolean; chars: number };

export type MessageBlock = { type: string; tokens: number };

export type ContextMessage = { role: string; tokens: number; blocks: MessageBlock[] };

export type ContextFacts = {
  model: string | undefined;
  window: number;
  total: number | null;
  reserve: number;
  sections: ContextSection[];
  tools: ContextTool[];
  messages: ContextMessage[];
};
