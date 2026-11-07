import { LauncherError } from "../shared/index.ts";
import type { RenderInput, RenderResult } from "./types.ts";

export const RENDER_COPIED_ENTRIES = [
  "agents",
  "prompts",
  "skills",
  "themes",
  "extensions",
  "AGENTS.md",
  "SYSTEM.md",
  "keybindings.json",
] as const;

export const renderAgentDir = async (_input: RenderInput): Promise<RenderResult> => {
  throw new LauncherError("renderAgentDir is not implemented");
};
