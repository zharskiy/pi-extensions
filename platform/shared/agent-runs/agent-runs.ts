import { join } from "node:path";
import { isPlainObject } from "../guards.ts";

export const RUN_MANIFEST = "manifest.json";

export type RunCleanup = "removed" | "branch kept" | "kept";

export type RunManifest = {
  predecessorId: string | undefined;
  successorId: string | undefined;
  worktree: { cleanup?: RunCleanup } | undefined;
};

export const sessionStem = (file: string) => file.replace(/\.jsonl$/, "");

export const runsDir = (stem: string) => join(stem, "agents");

export const fallbackStemsRoot = (agentDir: string) => join(agentDir, "pi-subagents");

export const sessionRunsDir = (session: { agentDir: string; id: string; file?: string }) =>
  runsDir(session.file ? sessionStem(session.file) : join(fallbackStemsRoot(session.agentDir), session.id));

const keeps = (worktree: unknown) =>
  isPlainObject(worktree) ? worktree.cleanup !== "removed" : Boolean(worktree);

export const runRules = (manifest: unknown) => {
  const run = isPlainObject(manifest) ? manifest : {};

  return {
    links: [run.predecessorId, run.successorId].filter((id): id is string => typeof id === "string"),
    keep: keeps(run.worktree),
  };
};
