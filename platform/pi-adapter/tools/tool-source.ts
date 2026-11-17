import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ToolSource } from "../types/context.ts";

const BUILTIN_PATH_PREFIX = "builtin:";

export const MCP_SOURCE_PATH = `${BUILTIN_PATH_PREFIX}mcp`;

export const MCP_PREFIX = "mcp__";

const SHELL_TOOLS = ["bash", "powershell"] as const;

const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

export const BUILTIN_TOOLS = ["read", ...SHELL_TOOLS, "edit", "write", ...SEARCH_TOOLS] as const;

export const SHELLS: readonly string[] = SHELL_TOOLS;

export const FILE_SEARCH_TOOLS: readonly string[] = SEARCH_TOOLS;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

export const isBuiltinTool = (name: string): name is BuiltinTool =>
  (BUILTIN_TOOLS as readonly string[]).includes(name);

type SourcePath = Pick<SourceInfo, "path">;

export const piShippedSource = (info: SourcePath | undefined) =>
  info?.path.startsWith(BUILTIN_PATH_PREFIX) === true;

export const toolSourceOf = (info: SourcePath | undefined): ToolSource => {
  if (info?.path === MCP_SOURCE_PATH) {
    return "mcp";
  }

  return piShippedSource(info) ? "builtin" : "extension";
};
