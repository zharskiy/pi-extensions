import { join } from "node:path";
import type { SessionInfo } from "../../../../core/adapter/contract.ts";
import { sessionDataDir } from "../../../../core/manager/paths.ts";

export const NAMESPACE = "pi-subagents";

export const MANIFEST_FILE = "manifest.json";

export const agentsDirFor = (info: SessionInfo) => join(sessionDataDir(info, NAMESPACE), "agents");
