import type { WorkspaceRootsConfig } from "../config/index.ts";
import { expandHome, isWithin, LauncherError, realOrResolvedSync } from "../shared/index.ts";
import type { Workspace } from "./types.ts";

const resolveRoot = (root: string) => realOrResolvedSync(expandHome(root));

export const assertWithinWorkspaceRoots = (
  workspace: Workspace,
  workspaceRoots: WorkspaceRootsConfig | undefined,
): "ok" | "warn" => {
  if (workspaceRoots === undefined) {
    return "ok";
  }

  const roots = workspaceRoots.roots.map(resolveRoot);
  const outside = [workspace.repoRoot, workspace.gitCommonDir].find(
    (path) => path !== undefined && !roots.some((root) => isWithin(path, root)),
  );

  if (outside === undefined) {
    return "ok";
  }

  if (workspaceRoots.outside === "warn") {
    return "warn";
  }

  throw new LauncherError(
    `${outside} is outside the allowed workspace roots (${workspaceRoots.roots.join(", ")})`,
    "start pi inside one of the workspaceRoots",
  );
};
