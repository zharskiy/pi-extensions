import {
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
  estimateTokens,
  getLastAssistantUsage,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ContextBreakdown,
  ContextPart,
  EntryRender,
  Host,
  PromptTool,
  RequestUsage,
} from "./contract.ts";
import { themeLike } from "./pi-tools.ts";
import type { HostState } from "./pi-ui.ts";
import { replaySystemMessages } from "./session-file.ts";
import { requestUsageOf, sumAssistantUsage } from "./usage.ts";

type Message = Parameters<typeof estimateTokens>[0];

type ToolSource = { name: string; path: string; exposure: string };

export type ToolKind = keyof ContextBreakdown["tools"];

const MEMORY_SECTION = "project_context";

const SKILLS_SECTION = "skills";

const UNDECLARED: readonly string[] = ["hidden", "deferred", "codemode"];

const MEMORY_BLOCK = /<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/g;

const SKILL_BLOCK = /<skill>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/skill>/g;

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export const charTokens = (text: string) => Math.ceil(text.length / 4);

export const toolTokens = (tool: PromptTool) => Math.ceil(JSON.stringify(tool).length / 4);

export const toolKind = (path: string | undefined): ToolKind => {
  if (path === "builtin:mcp") {
    return "mcp";
  }

  return path?.startsWith("builtin:") ? "builtin" : "extension";
};

const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => XML_ENTITIES[name]);

const blockParts = (
  text: string,
  pattern: RegExp,
  name: (match: RegExpMatchArray) => string,
): ContextPart[] =>
  [...text.matchAll(pattern)].map((match) => ({ name: name(match), tokens: charTokens(match[0]) }));

const partsOf = (
  text: string | undefined,
  pattern: RegExp,
  name: (match: RegExpMatchArray) => string,
  whole: string,
) => {
  if (!text) {
    return [];
  }

  const parts = blockParts(text, pattern, name);

  return parts.length > 0 ? parts : [{ name: whole, tokens: charTokens(text) }];
};

const sumTokens = (parts: readonly ContextPart[]) => parts.reduce((sum, part) => sum + part.tokens, 0);

export const splitSections = (sections: ReadonlyMap<string, string>) => {
  const memoryFiles = partsOf(
    sections.get(MEMORY_SECTION),
    MEMORY_BLOCK,
    (match) => unescapeXml(match[1] ?? ""),
    "project context",
  );
  const skills = partsOf(
    sections.get(SKILLS_SECTION),
    SKILL_BLOCK,
    (match) => unescapeXml((match[1] ?? "").trim()),
    "skills",
  );
  const allTokens = Array.from(sections.values()).reduce((sum, text) => sum + charTokens(text), 0);

  return {
    systemPrompt: Math.max(0, allTokens - sumTokens(memoryFiles) - sumTokens(skills)),
    memoryFiles,
    skills,
  };
};

export const sectionsOfPrompt = (prompt: string): Map<string, string> => {
  const sections = new Map<string, string>();

  const rest = [MEMORY_SECTION, SKILLS_SECTION].reduce((text, name) => {
    const match = new RegExp(`<${name}>\\n[\\s\\S]*?\\n</${name}>`).exec(text);

    if (!match) {
      return text;
    }

    sections.set(name, match[0]);

    return text.replace(match[0], "");
  }, prompt);

  sections.set("prompt", rest);

  return sections;
};

type Buckets = ContextBreakdown["messages"];

const emptyBuckets = (): Buckets => ({
  count: 0,
  user: 0,
  assistant: 0,
  thinking: 0,
  toolCalls: 0,
  toolResults: 0,
  other: 0,
});

type Block = { type?: string };

const blockBucket = (block: Block): keyof Buckets =>
  block.type === "thinking" ? "thinking" : block.type === "toolCall" ? "toolCalls" : "assistant";

const addTo = (buckets: Buckets, key: keyof Buckets, tokens: number): Buckets => ({
  ...buckets,
  [key]: buckets[key] + tokens,
});

const addMessage = (buckets: Buckets, message: Message): Buckets => {
  const counted = { ...buckets, count: buckets.count + 1 };

  if (message.role === "assistant") {
    return (message.content as Block[]).reduce(
      (sum, block) =>
        addTo(sum, blockBucket(block), estimateTokens({ ...message, content: [block] } as Message)),
      counted,
    );
  }

  const key: keyof Buckets =
    message.role === "user" ? "user" : message.role === "toolResult" ? "toolResults" : "other";

  return addTo(counted, key, estimateTokens(message));
};

export const messageBuckets = (messages: readonly unknown[]): Buckets =>
  (messages as Message[]).filter((message) => message.role !== "system").reduce(addMessage, emptyBuckets());

const emptyTools = (): ContextBreakdown["tools"] => ({ builtin: [], mcp: [], extension: [] });

export const classifyTools = (
  declared: readonly PromptTool[],
  sources: readonly ToolSource[],
): ContextBreakdown["tools"] => {
  const byName = new Map(sources.map((source) => [source.name, source]));
  const names = new Set(declared.map((tool) => tool.name));
  const tools = emptyTools();

  declared.forEach((tool) => {
    tools[toolKind(byName.get(tool.name)?.path)].push({ name: tool.name, tokens: toolTokens(tool) });
  });

  sources
    .filter((source) => toolKind(source.path) === "mcp" && !names.has(source.name))
    .filter((source) => source.exposure === "deferred" || source.exposure === "codemode")
    .forEach((source) => {
      tools.mcp.push({ name: source.name, tokens: 0 });
    });

  return tools;
};

type CompactionSettings = {
  enabled?: boolean;
  reserveTokens?: number;
  modelOverrides?: Record<string, { reserveTokens?: number } | undefined>;
};

export const reserveOf = (
  compaction: CompactionSettings | undefined,
  model: { provider: string; id: string } | undefined,
): number => {
  if ((compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled) === false) {
    return 0;
  }

  const override = model
    ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens
    : undefined;

  return override ?? compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
};

type ContextApi = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getSettings">;

const toolSources = (pi: ContextApi): ToolSource[] =>
  pi.getAllTools().map((tool) => ({ name: tool.name, path: tool.sourceInfo.path, exposure: tool.exposure }));

const activeDeclarations = (pi: ContextApi): PromptTool[] => {
  const active = new Set(pi.getActiveTools());

  return pi
    .getAllTools()
    .filter((tool) => active.has(tool.name) && !UNDECLARED.includes(tool.exposure))
    .map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters }));
};

export const buildBreakdown = (pi: ContextApi, ctx: ExtensionContext): ContextBreakdown => {
  const messages = ctx.sessionManager.buildSessionProjection().messages;
  const replay = replaySystemMessages(messages);
  const replayed = replay.sections.size > 0 || replay.tools.size > 0;
  const sections = replayed ? replay.sections : sectionsOfPrompt(ctx.getSystemPrompt());
  const declared = replayed ? Array.from(replay.tools.values()) : activeDeclarations(pi);
  const usage = ctx.getContextUsage();
  const settings = pi.getSettings() as { compaction?: CompactionSettings };

  return {
    model: ctx.model?.name ?? ctx.model?.id,
    window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    total: usage?.tokens ?? null,
    reserve: reserveOf(settings.compaction, ctx.model),
    ...splitSections(sections),
    tools: classifyTools(declared, toolSources(pi)),
    messages: messageBuckets(messages),
  };
};

const fitLines = (lines: string[], width: number) => lines.map((line) => truncateToWidth(line, width, "…"));

type UsageCache = { session: string; file: string | undefined; leaf: string | null; usage: RequestUsage };

export const contextHost = (
  pi: ContextApi & Pick<ExtensionAPI, "registerEntryRenderer">,
  state: HostState,
): Pick<Host, "contextBreakdown" | "lastRequestUsage" | "mainRequestUsage" | "registerEntryRenderer"> => {
  let cache: UsageCache | undefined;

  const mainRequestUsage = () => {
    const ctx = state.ctx;

    if (!ctx) {
      cache = undefined;
      return requestUsageOf(undefined);
    }

    const manager = ctx.sessionManager;
    const session = manager.getSessionId();
    const file = manager.getSessionFile();
    const leaf = manager.getLeafId();

    if (cache && cache.session === session && cache.file === file && cache.leaf === leaf) {
      return cache.usage;
    }

    cache = { session, file, leaf, usage: sumAssistantUsage(manager.getEntries()) };

    return cache.usage;
  };

  return {
    contextBreakdown: () => (state.ctx ? buildBreakdown(pi, state.ctx) : undefined),
    lastRequestUsage: () => {
      const usage = state.ctx ? getLastAssistantUsage(state.ctx.sessionManager.getBranch()) : undefined;

      return usage ? requestUsageOf(usage) : undefined;
    },
    mainRequestUsage,
    registerEntryRenderer: (customType: string, render: EntryRender) => {
      pi.registerEntryRenderer(
        customType,
        (entry, options, theme: Theme): Component => ({
          render: (width) => fitLines(render(entry.data, width, options.expanded, themeLike(theme)), width),
          invalidate: () => {},
        }),
      );
    },
  };
};
