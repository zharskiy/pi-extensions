import type { SettingsScope } from "../../../../platform/shared/index.ts";
import type { AgentOverride } from "../model/agent-schema.ts";

export const SCOPES: readonly SettingsScope[] = ["project", "user"];

export type SetupChange = { name: string; patch: AgentOverride };
