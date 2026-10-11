import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../adapter/contract.ts";

export const agentsDirFor = (info: SessionInfo | undefined) => {
  if (!info) {
    return join(tmpdir(), "pi-subagents", "no-session");
  }

  if (info.file) {
    return join(info.file.replace(/\.jsonl$/, ""), "agents");
  }

  return join(tmpdir(), "pi-subagents", info.id, "agents");
};
