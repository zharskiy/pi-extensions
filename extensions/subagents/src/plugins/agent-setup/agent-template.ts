import { INHERIT_MODEL } from "../../model/agent-schema.ts";

export type AgentKind = "lead" | "chore";

export type AgentTemplate = { name: string; description: string; kind: AgentKind; model: string };

export const DESCRIPTION_PLACEHOLDER =
  "Use for <when the main session should pick this agent>. Not for <what other agents do>. Returns <what>.";

type KindDefaults = { limit: number; tools: string; subagents: string; mcp: boolean; scope: string };

const KIND_DEFAULTS: Record<AgentKind, KindDefaults> = {
  lead: {
    limit: 120_000,
    tools: "[read, grep, find, ls, edit, write, bash]",
    subagents: "[scout]",
    mcp: true,
    scope: "Read the code you change and follow its style. Change only what the task needs.",
  },
  chore: {
    limit: 80_000,
    tools: "[read, grep, find, ls]",
    subagents: "[]",
    mcp: false,
    scope: "You never edit files. Read only what the task names and what it leads to.",
  },
};

const LEAD_DELEGATION = [
  "- Give a search across more than a few files to a scout, ask for path:line citations with the quoted line, " +
    "and read yourself the code your change rests on.",
  "- Never hand your whole task to another agent. If you cannot finish it yourself, return " +
    "`Status: partial` with what is left under Open.",
];

const needsQuotes = (text: string) =>
  /^["'[]/.test(text) || /^(true|false|-?\d+(\.\d+)?)$/.test(text) || /^[|>]$/.test(text);

const scalar = (text: string) => (needsQuotes(text) ? `"${text}"` : text);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const frontmatter = ({ name, description, kind, model }: AgentTemplate) => {
  const defaults = KIND_DEFAULTS[kind];

  return [
    "---",
    `# A ${kind} agent. Every field is described in the comment above it; remove the comments if you like.`,
    "# name: plain name of letters, digits, '_' and '-'; the name callers start the agent by.",
    `name: ${name}`,
    "# description: when the main session should use this agent, what it is not for, what it returns.",
    `description: ${scalar(oneLine(description) || DESCRIPTION_PLACEHOLDER)}`,
    `# model: provider/id or provider/id:thinking; ${INHERIT_MODEL} uses the main session's model.`,
    `model: ${oneLine(model) || INHERIT_MODEL}`,
    "# limit: context limit in tokens, at least 5000.",
    `limit: ${defaults.limit}`,
    "# tools: tool names, all for the tools active in the main session, or [] for none.",
    `tools: ${defaults.tools}`,
    "# skills: skill names, all for every skill of the main session, or [] for none.",
    "skills: []",
    "# subagents: agent names it may start, all for every other agent, or [] for none.",
    `subagents: ${defaults.subagents}`,
    "# worktree: true runs it in its own git worktree under .pi/worktrees.",
    "worktree: false",
    "# mcp: true gives it the MCP servers from mcp.json; leads have true, chores false.",
    `mcp: ${defaults.mcp}`,
    "# The body below is the agent's instructions. Every agent also gets the shared result shape",
    "# (Status, Verification, Open); list only this agent's own result sections under Sections:.",
    "---",
  ];
};

const body = (kind: AgentKind) => [
  "You <do one job, in one sentence>.",
  "",
  `- ${KIND_DEFAULTS[kind].scope}`,
  "- <How to start: what to read, search or run first.>",
  "- <What to leave alone: files, commands or changes outside the task.>",
  ...(kind === "lead" ? LEAD_DELEGATION : []),
  "- Stop when <the condition that ends the task>; put what is left under Open.",
  "",
  "Sections:",
  "<Section>: <what goes in it>, for example one per line, `path - change`.",
];

export const agentTemplate = (template: AgentTemplate) =>
  `${[...frontmatter(template), ...body(template.kind)].join("\n")}\n`;
