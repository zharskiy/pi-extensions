import type { Backend } from "../backend/index.ts";
import { type EffectiveConfig, loadEffectiveConfig } from "../config/index.ts";
import { realOrResolvedSync, repoHash, stateLayout } from "../shared/index.ts";
import {
  assertSafeMounts,
  assertSafeWorkspace,
  assertWithinWorkspaceRoots,
  discoverWorkspace,
  type Workspace,
  workspaceFolder,
} from "../workspace/index.ts";
import { type CliDeps, pathsOf } from "./deps.ts";

export interface LaunchContext {
  workspace: Workspace;
  effective: EffectiveConfig;
  stateDir: string;
  repoHash: string;
}

type ContextMode = "sandbox" | "host";

interface ContextOptions {
  overlays?: boolean;
}

type Opened<M extends ContextMode> = M extends "host"
  ? { context: LaunchContext }
  : { context: LaunchContext; backend: Backend };

const isHomeOrRoot = (deps: CliDeps, folder: string) =>
  folder === "/" || folder === realOrResolvedSync(deps.home);

const discoverContext = async (deps: CliDeps, lenient: boolean, options: ContextOptions) => {
  const stateDir = pathsOf(deps).stateDir;
  const folder = await workspaceFolder(deps.cwd);
  const mounted = folder.root ?? folder.realCwd;
  const effective = await loadEffectiveConfig({ env: deps.env, home: deps.home });

  if (!lenient) {
    assertSafeMounts([mounted], { home: deps.home, env: deps.env });

    assertWithinWorkspaceRoots(
      { cwd: folder.realCwd, repoRoot: mounted, isGitRepo: false },
      effective.config.workspaceRoots,
    );
  }

  const overlays = lenient
    ? options.overlays === true && !isHomeOrRoot(deps, mounted)
    : effective.config.mounts.autoOverlays;
  const workspace = await discoverWorkspace(folder, deps.runner, stateLayout(stateDir).emptyDir, {
    lenient,
    overlays,
  });
  return { workspace, effective, stateDir, repoHash: repoHash(workspace.repoRoot) };
};

export const checkWorkspaceRoots = (context: LaunchContext) => {
  assertWithinWorkspaceRoots(context.workspace, context.effective.config.workspaceRoots);
};

export const openContext = async <M extends ContextMode>(
  deps: CliDeps,
  mode: M,
  options: ContextOptions = {},
): Promise<Opened<M>> => {
  const context = await discoverContext(deps, mode !== "sandbox", options);

  if (mode === "host") {
    return { context } as Opened<M>;
  }

  checkWorkspaceRoots(context);

  assertSafeWorkspace(context.workspace, { home: deps.home, env: deps.env });

  return { context, backend: deps.backend() } as Opened<M>;
};
