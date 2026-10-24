import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

const toolsSection = (declaredTools: string[], toolSnippets: Record<string, string>) => {
  const visible = declaredTools.filter((name) => Boolean(toolSnippets[name]));
  const list =
    visible.length > 0 ? visible.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";

  return `${list}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
};

const fileToolRule = (declaredTools: string[]) => {
  const hasBash = declaredTools.includes("bash");
  const hasPowerShell = declaredTools.includes("powershell");
  const hasSearchTool = ["grep", "find", "ls"].some((name) => declaredTools.includes(name));

  if ((!hasBash && !hasPowerShell) || hasSearchTool) {
    return [];
  }

  if (hasBash && hasPowerShell) {
    return ["Use bash or PowerShell for file operations like listing, searching, and finding files"];
  }

  if (hasPowerShell) {
    return ["Use PowerShell for file operations like listing, searching, and finding files"];
  }

  return ["Use bash for file operations like ls, rg, find"];
};

const rulesSection = (
  declaredTools: string[],
  toolGuidelines: Record<string, string[]>,
  promptGuidelines: string[],
) => {
  const candidates = [
    ...fileToolRule(declaredTools),
    ...declaredTools.flatMap((name) => toolGuidelines[name] ?? []),
    ...promptGuidelines,
    "Be concise in your responses",
    "Show file paths clearly when working with files",
  ];

  const rules = Array.from(new Set(candidates.map((rule) => rule.trim()).filter(Boolean)));

  return rules.map((rule) => `- ${rule}`).join("\n");
};

const docsSection =
  () => `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

export const replaceMainPrompt = (options: NormalizedBuildSystemPromptOptions, prompt: string) => {
  const declaredTools = options.selectedTools.filter((name) => !options.hiddenTools.includes(name));

  options.customPrompt = prompt;
  options.sections = {
    tools: toolsSection(declaredTools, options.toolSnippets),
    rules: rulesSection(declaredTools, options.toolGuidelines, options.promptGuidelines),
    docs: docsSection(),
    ...options.sections,
  };
};
