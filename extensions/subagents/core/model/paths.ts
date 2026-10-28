import { join } from "node:path";
import type { SessionInfo } from "../../../../platform/pi-adapter/index.ts";
import { handoffPath } from "../../../../platform/shared/index.ts";

export const NAMESPACE = "pi-subagents";

export const MANIFEST_FILE = "manifest.json";

export const agentsDirFor = (info: SessionInfo) =>
  join(info.file ? info.file.replace(/\.jsonl$/, "") : join(info.agentDir, NAMESPACE, info.id), "agents");

export const handoffPathFor = (info: SessionInfo, agentId: string) => handoffPath(info.id, { agentId });

export const userAgentsDir = (info: Pick<SessionInfo, "agentDir">) => join(info.agentDir, "agents");

export const projectAgentsDir = (info: Pick<SessionInfo, "cwd">) => join(info.cwd, ".pi", "agents");
