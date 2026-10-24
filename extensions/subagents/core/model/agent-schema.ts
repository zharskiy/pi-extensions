export const ALL = "all";

export const INHERIT_MODEL = "inherit";

export const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const PLAIN_NAME_TEXT = "letters, digits, '_' and '-', not starting with '-'";

export type Grant = string[] | typeof ALL;

export type AgentFrontmatter = {
  name: string;
  description: string;
  model?: string;
  limit: number;
  tools: Grant;
  skills: Grant;
  subagents: Grant;
  worktree?: boolean;
  mcp?: boolean;
};

export type AgentOverride = { model?: string; thinking?: string; skills?: Grant };

export type AgentOverrides = Record<string, AgentOverride>;
