import type {
  ContextFacts,
  ContextMessage,
  ContextSection,
  ContextTool,
  ToolSource,
} from "../../../pi-adapter/index.ts";

export type Part = { name: string; tokens: number };

export type MessageKey = "user" | "assistant" | "thinking" | "toolCalls" | "toolResults" | "other";

type Messages = { count: number } & Record<MessageKey, number>;

export type Breakdown = {
  model: string | undefined;
  window: number;
  total: number | null;
  reserve: number;
  systemPrompt: number;
  memoryFiles: Part[];
  skills: Part[];
  tools: Record<ToolSource, Part[]>;
  messages: Messages;
};

export const MESSAGE_KEYS: readonly MessageKey[] = [
  "user",
  "assistant",
  "thinking",
  "toolCalls",
  "toolResults",
  "other",
];

const MEMORY_SECTION = "project_context";

const SKILLS_SECTION = "skills";

const MEMORY_BLOCK = /<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/g;

const SKILL_BLOCK = /<skill>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/skill>/g;

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const ROLE_KEYS: Record<string, MessageKey> = { user: "user", toolResult: "toolResults" };

const BLOCK_KEYS: Record<string, MessageKey> = { thinking: "thinking", toolCall: "toolCalls" };

const charTokens = (chars: number) => Math.ceil(chars / 4);

export const sumParts = (parts: readonly Part[]) => parts.reduce((sum, part) => sum + part.tokens, 0);

const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => XML_ENTITIES[name]);

const partsOf = (
  text: string | undefined,
  pattern: RegExp,
  name: (match: RegExpMatchArray) => string,
  whole: string,
): Part[] => {
  if (!text) {
    return [];
  }

  const parts = [...text.matchAll(pattern)].map((match) => ({
    name: name(match),
    tokens: charTokens(match[0].length),
  }));

  return parts.length > 0 ? parts : [{ name: whole, tokens: charTokens(text.length) }];
};

const promptParts = (sections: readonly ContextSection[]) => {
  const textOf = (name: string) => sections.find((section) => section.name === name)?.text;

  const memoryFiles = partsOf(
    textOf(MEMORY_SECTION),
    MEMORY_BLOCK,
    (match) => unescapeXml(match[1] ?? ""),
    "project context",
  );

  const skills = partsOf(
    textOf(SKILLS_SECTION),
    SKILL_BLOCK,
    (match) => unescapeXml((match[1] ?? "").trim()),
    "skills",
  );

  const all = sections.reduce((sum, section) => sum + charTokens(section.text.length), 0);

  return {
    systemPrompt: Math.max(0, all - sumParts(memoryFiles) - sumParts(skills)),
    memoryFiles,
    skills,
  };
};

const listed = (tool: ContextTool) => !tool.onDemand || tool.source === "mcp";

const toolTokens = (tool: ContextTool) => (tool.onDemand ? 0 : charTokens(tool.chars));

const toolParts = (tools: readonly ContextTool[]): Record<ToolSource, Part[]> => {
  const of = (source: ToolSource) =>
    tools
      .filter((tool) => tool.source === source && listed(tool))
      .map((tool) => ({ name: tool.name, tokens: toolTokens(tool) }));

  return { builtin: of("builtin"), mcp: of("mcp"), extension: of("extension") };
};

const sharesOf = (message: ContextMessage) => {
  if (message.role === "assistant") {
    return message.blocks.map((block) => ({
      key: BLOCK_KEYS[block.type] ?? "assistant",
      tokens: block.tokens,
    }));
  }

  return [{ key: ROLE_KEYS[message.role] ?? "other", tokens: message.tokens }];
};

const messageBuckets = (messages: readonly ContextMessage[]): Messages => {
  const shares = messages.flatMap(sharesOf);

  const totals = MESSAGE_KEYS.map((key) => [
    key,
    shares.filter((share) => share.key === key).reduce((sum, share) => sum + share.tokens, 0),
  ]);

  return { count: messages.length, ...(Object.fromEntries(totals) as Record<MessageKey, number>) };
};

export const breakdownOf = (facts: ContextFacts): Breakdown => ({
  model: facts.model,
  window: facts.window,
  total: facts.total,
  reserve: facts.reserve,
  ...promptParts(facts.sections),
  tools: toolParts(facts.tools),
  messages: messageBuckets(facts.messages),
});
