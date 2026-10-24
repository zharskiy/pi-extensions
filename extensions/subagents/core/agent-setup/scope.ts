import type { AgentOverride } from "../model/agent-schema.ts";

export type Scope = "project" | "user";

export const SCOPES: readonly Scope[] = ["project", "user"];

export type SetupChange = { name: string; patch: AgentOverride };
