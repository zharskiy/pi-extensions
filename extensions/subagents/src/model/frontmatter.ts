export const ALL = "all";

export type Grant = string[] | typeof ALL;

export type AgentFrontmatter = {
  name: string;
  description: string;
  model?: string;
  limit: number;
  tools: Grant;
  skills: Grant;
  subagents: Grant;
  worktree: boolean;
};

type FrontmatterKey = keyof AgentFrontmatter;

export type FieldKind = "name" | "text" | "model" | "integer" | "list" | "switch";

type FieldRule = {
  kind: FieldKind;
  required: boolean;
  byDefault?: string;
  meaning: string;
  hint?: string;
  namesMeaning?: string;
  allMeaning?: string;
  entry?: { pattern: RegExp; text: string };
  min?: number;
};

export type FieldSpec = FieldRule & { key: FrontmatterKey };

export const MIN_LIMIT = 5_000;

export const INHERIT_MODEL = "inherit";

const PLAIN_NAME = {
  pattern: /^[A-Za-z0-9_][A-Za-z0-9_-]*$/,
  text: "plain names of letters, digits, '_' and '-', not starting with '-'",
};

const RULES: { [K in FrontmatterKey]: FieldRule } = {
  name: { kind: "name", required: true, meaning: "Name the caller passes to `run_agent`." },
  description: {
    kind: "text",
    required: true,
    meaning: "When to use the agent; shown in the `run_agent` description.",
  },
  model: {
    kind: "model",
    required: false,
    byDefault: INHERIT_MODEL,
    meaning: "Model the agent runs on; `inherit` is the main session's model.",
  },
  limit: {
    kind: "integer",
    required: true,
    min: MIN_LIMIT,
    hint: "context limit in tokens, for example limit: 100000",
    meaning: "Context limit in tokens; at the limit the agent writes a handoff.",
  },
  tools: {
    kind: "list",
    required: true,
    namesMeaning: "tool names",
    allMeaning: "the tools active in the main session",
    entry: PLAIN_NAME,
    meaning:
      "Tools the agent may use; any tool also brings every MCP tool, `codemode` and `tool_search`, and `[]` brings none of them.",
  },
  skills: {
    kind: "list",
    required: true,
    namesMeaning: "skill names",
    allMeaning: "every skill of the main session",
    entry: PLAIN_NAME,
    meaning: "Skills by name.",
  },
  subagents: {
    kind: "list",
    required: true,
    namesMeaning: "agent names it may start",
    allMeaning: "every other agent",
    entry: PLAIN_NAME,
    meaning: "Agents it may start.",
  },
  worktree: {
    kind: "switch",
    required: false,
    byDefault: "false",
    meaning: "`true` runs the agent in its own git worktree.",
  },
};

export const FRONTMATTER_FIELDS: readonly FieldSpec[] = Object.entries(RULES).map(([key, rule]) => ({
  key: key as FrontmatterKey,
  ...rule,
}));

export const missingFieldMessage = (spec: FieldSpec) => {
  const hint =
    spec.kind === "list" ? `${spec.namesMeaning}, all for ${spec.allMeaning}, or [] for none` : spec.hint;

  return hint ? `${spec.key} is required (${hint})` : `${spec.key} is required`;
};
