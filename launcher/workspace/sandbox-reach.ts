import { isWithin, knownRepos, realOrResolved, repoRecordOf } from "../shared/index.ts";
import { findGitRoot } from "./git/layout.ts";
import { assertSafeMounts } from "./guard.ts";

interface SandboxReachContext {
  home: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}

export const startedRoots = async (cwd: string) => {
  const folder = await realOrResolved(cwd);
  const root = await findGitRoot(folder);

  return root === undefined ? [folder] : [folder, root];
};

const sandboxedRoots = async (stateDir: string) => {
  const records = await Promise.all((await knownRepos(stateDir)).map((hash) => repoRecordOf(stateDir, hash)));

  return Promise.all(
    records.flatMap((record) => (record === undefined ? [] : [realOrResolved(record.root)])),
  );
};

const canHoldSandbox = (root: string, context: SandboxReachContext) => {
  try {
    assertSafeMounts([root], { home: context.home, env: context.env });

    return true;
  } catch {
    return false;
  }
};

export const isSandboxWritable = async (paths: string[], context: SandboxReachContext) => {
  const [gitRoots, sandboxed] = await Promise.all([
    Promise.all(paths.map(findGitRoot)),
    sandboxedRoots(context.stateDir),
  ]);

  return (
    gitRoots.some((root) => root !== undefined && canHoldSandbox(root, context)) ||
    sandboxed.some((root) => paths.some((path) => isWithin(path, root)))
  );
};
