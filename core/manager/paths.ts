import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../adapter/contract.ts";

export const sessionDataDir = (info: SessionInfo | undefined, namespace: string) => {
  if (!info) {
    return join(tmpdir(), namespace, "no-session");
  }

  if (info.file) {
    return info.file.replace(/\.jsonl$/, "");
  }

  return join(tmpdir(), namespace, info.id);
};
