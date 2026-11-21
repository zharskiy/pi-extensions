import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../../../../platform/pi-adapter/index.ts";
import { handoffPath, projectPath, RUN_MANIFEST, sessionRunsDir } from "../../../../platform/shared/index.ts";

export const NAMESPACE = "pi-subagents";

export const MANIFEST_FILE = RUN_MANIFEST;

export const agentsDirFor = (info: SessionInfo) => sessionRunsDir(info);

export const handoffPathFor = (info: SessionInfo, agentId: string) => handoffPath(info.id, { agentId });

export const userAgentsDir = (info: Pick<SessionInfo, "agentDir">) => join(info.agentDir, "agents");

export const projectAgentsDir = (info: Pick<SessionInfo, "cwd">) => projectPath(info.cwd, "agents");

export const readPrompt = (root: string, file: string) =>
  readFileSync(join(root, "prompts", file), "utf8").trim();
