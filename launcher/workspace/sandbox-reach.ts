import { isWithin, knownRepos, realOrResolved, repoRecordOf } from "../shared/index.ts";
import { checkRoot } from "./roots.ts";

interface SandboxReachContext {
  home: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  workspaceRoot?: string;
}

const sandboxedRoots = async (stateDir: string) => {
  const records = await Promise.all((await knownRepos(stateDir)).map((hash) => repoRecordOf(stateDir, hash)));

  const recorded = records.flatMap((record) =>
    record === undefined
      ? []
      : [record.root, ...(record.workspaceRoot === undefined ? [] : [record.workspaceRoot])],
  );

  return Promise.all(recorded.map(realOrResolved));
};

const mountedRoots = (context: SandboxReachContext) => {
  if (context.workspaceRoot === undefined) {
    return [];
  }

  const verdict = checkRoot(context.workspaceRoot, context);

  return verdict.ok ? [verdict.resolved] : [];
};

export const sandboxWriteRoots = async (context: SandboxReachContext) => [
  ...new Set([...mountedRoots(context), ...(await sandboxedRoots(context.stateDir))]),
];

export const isSandboxWritable = async (paths: string[], context: SandboxReachContext) => {
  const roots = await sandboxWriteRoots(context);

  return paths.some((path) => roots.some((root) => isWithin(path, root)));
};
