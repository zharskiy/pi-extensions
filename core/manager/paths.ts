import { join } from "node:path";
import type { SessionInfo } from "../adapter/contract.ts";

export const sessionDataDir = (info: SessionInfo, namespace: string) =>
  info.file ? info.file.replace(/\.jsonl$/, "") : join(info.agentDir, namespace, info.id);
