import { join } from "node:path";
import type { SessionInfo } from "../../../../core/adapter/contract.ts";
import { sessionDataDir } from "../../../../core/manager/paths.ts";

export const NAMESPACE = "pi-subagents";

export const agentsDirFor = (info: SessionInfo | undefined) =>
  info ? join(sessionDataDir(info, NAMESPACE), "agents") : sessionDataDir(undefined, NAMESPACE);
