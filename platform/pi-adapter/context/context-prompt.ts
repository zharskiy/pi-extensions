import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { replaySystemMessages } from "../runtime/session-file.ts";
import type { ContextSection, ContextTool, ToolSource } from "../types/context.ts";
import type { PromptTool } from "../types/messages.ts";

export type PromptApi = Pick<ExtensionAPI, "getAllTools" | "getActiveTools">;

const PROMPT_SECTIONS: readonly string[] = ["project_context", "skills"];

const ON_DEMAND: readonly string[] = ["deferred", "codemode"];

const UNDECLARED: readonly string[] = ["hidden", ...ON_DEMAND];

const sourceOf = (path: string | undefined): ToolSource => {
  if (path === "builtin:mcp") {
    return "mcp";
  }

  return path?.startsWith("builtin:") ? "builtin" : "extension";
};

const declarationOf = (tool: ToolInfo): PromptTool => ({
  name: tool.name,
  description: tool.description ?? "",
  parameters: tool.parameters,
});

const charsOf = (tool: PromptTool) => JSON.stringify(tool).length;

const sectionText = (prompt: string, name: string) =>
  new RegExp(`<${name}>\\n[\\s\\S]*?\\n</${name}>`).exec(prompt)?.[0];

const sectionsOfPrompt = (prompt: string): ContextSection[] => {
  const found = PROMPT_SECTIONS.map((name) => ({ name, text: sectionText(prompt, name) })).filter(
    (section): section is ContextSection => section.text !== undefined,
  );

  const rest = found.reduce((text, section) => text.replace(section.text, ""), prompt);

  return [...found, { name: "prompt", text: rest }];
};

const activeDeclarations = (pi: PromptApi, all: readonly ToolInfo[]) => {
  const active = new Set(pi.getActiveTools());

  return all
    .filter((tool) => active.has(tool.name) && !UNDECLARED.includes(tool.exposure))
    .map(declarationOf);
};

const toolFacts = (declared: readonly PromptTool[], all: readonly ToolInfo[]): ContextTool[] => {
  const paths = new Map(all.map((tool) => [tool.name, tool.sourceInfo.path]));
  const names = new Set(declared.map((tool) => tool.name));

  const loaded = declared.map((tool) => ({
    name: tool.name,
    source: sourceOf(paths.get(tool.name)),
    onDemand: false,
    chars: charsOf(tool),
  }));

  const waiting = all
    .filter((tool) => !names.has(tool.name) && ON_DEMAND.includes(tool.exposure))
    .map((tool) => ({
      name: tool.name,
      source: sourceOf(tool.sourceInfo.path),
      onDemand: true,
      chars: charsOf(declarationOf(tool)),
    }));

  return [...loaded, ...waiting];
};

export const promptFacts = (pi: PromptApi, messages: readonly unknown[], prompt: () => string) => {
  const replay = replaySystemMessages(messages);
  const replayed = replay.sections.size > 0 || replay.tools.size > 0;
  const all = pi.getAllTools();
  const declared = replayed ? Array.from(replay.tools.values()) : activeDeclarations(pi, all);

  const sections = replayed
    ? Array.from(replay.sections, ([name, text]) => ({ name, text }))
    : sectionsOfPrompt(prompt());

  return { sections, tools: toolFacts(declared, all) };
};
