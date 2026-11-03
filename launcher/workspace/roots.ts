import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceRootsConfig } from "../config/index.ts";
import { expandHome, isWithin, LauncherError } from "../shared/index.ts";
import type { Workspace } from "./types.ts";

const resolveRoot = (root: string) => {
  const path = resolve(expandHome(root));

  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

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
