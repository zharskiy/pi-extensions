import { expandHome, isWithin, LauncherError, realOrResolvedSync } from "../shared/index.ts";
import type { Workspace } from "./types.ts";

const resolveRoot = (root: string) => realOrResolvedSync(expandHome(root));

export const assertWithinWorkspaceRoots = (
  workspace: Workspace,
  workspaceRoots: { roots: string[] } | undefined,
) => {
  if (workspaceRoots === undefined) {
    return;
  }

  const roots = workspaceRoots.roots.map(resolveRoot);
  const outside = [workspace.repoRoot, workspace.gitCommonDir].find(
    (path) => path !== undefined && !roots.some((root) => isWithin(path, root)),
  );

  if (outside !== undefined) {
    throw new LauncherError(
      `${outside} is outside the allowed workspace roots (${workspaceRoots.roots.join(", ")})`,
      "start pi inside one of the workspaceRoots",
    );
  }
};
