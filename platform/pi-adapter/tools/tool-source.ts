import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ToolSource } from "../types/context.ts";

const BUILTIN_PATH_PREFIX = "builtin:";

export const MCP_SOURCE_PATH = `${BUILTIN_PATH_PREFIX}mcp`;

export const MCP_PREFIX = "mcp__";

type SourcePath = Pick<SourceInfo, "path">;

export const piShippedSource = (info: SourcePath | undefined) =>
  info?.path.startsWith(BUILTIN_PATH_PREFIX) === true;

export const toolSourceOf = (info: SourcePath | undefined): ToolSource => {
  if (info?.path === MCP_SOURCE_PATH) {
    return "mcp";
  }

  return piShippedSource(info) ? "builtin" : "extension";
};
