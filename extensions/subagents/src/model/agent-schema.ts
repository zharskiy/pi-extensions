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
  worktree?: boolean;
};
