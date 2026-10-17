export const ALL = "all";

export const INHERIT_MODEL = "inherit";

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
