import type { Backend } from "../backend/index.ts";
import { type EffectiveConfig, loadEffectiveConfig } from "../config/index.ts";
import { repoHash } from "../shared/index.ts";
import {
  assertSafeMounts,
  assertWithinHostRoot,
  assertWithinWorkspaceRoot,
  checkRoot,
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
  mountedRoot: string;
}

type ContextMode = "sandbox" | "host";

interface ContextOptions {
  rootOptional?: boolean;
}

type Opened<M extends ContextMode> = M extends "host"
  ? { context: LaunchContext }
  : { context: LaunchContext; backend: Backend };

const assertWithinRoot = (
  deps: CliDeps,
  workspace: Workspace,
  root: string | undefined,
  options: ContextOptions,
) => {
  if (root === undefined && options.rootOptional === true) {
    return;
  }

  assertWithinWorkspaceRoot(workspace, root, { home: deps.home, env: deps.env });
};

const mountedRootOf = (deps: CliDeps, workspace: Workspace, root: string | undefined) => {
  if (root === undefined) {
    return workspace.repoRoot;
  }

  const verdict = checkRoot(root, { home: deps.home, env: deps.env });

  return verdict.ok ? verdict.resolved : workspace.repoRoot;
};

const discoverContext = async (deps: CliDeps, lenient: boolean, options: ContextOptions) => {
  const stateDir = pathsOf(deps).stateDir;
  const folder = await workspaceFolder(deps.cwd);
  const mounted = folder.root ?? folder.realCwd;
  const effective = await loadEffectiveConfig({ env: deps.env, home: deps.home });

  if (!lenient) {
    assertSafeMounts([mounted], { home: deps.home, env: deps.env });

    assertWithinRoot(
      deps,
      { cwd: folder.realCwd, repoRoot: mounted, isGitRepo: false },
      effective.config.workspaceRoot,
      options,
    );
  }

  const workspace = await discoverWorkspace(folder);

  return {
    workspace,
    effective,
    stateDir,
    repoHash: repoHash(workspace.repoRoot),
    mountedRoot: mountedRootOf(deps, workspace, effective.config.workspaceRoot),
  };
};

export const checkHostRoot = (deps: CliDeps, context: LaunchContext) => {
  assertWithinHostRoot(context.workspace, context.effective.config.workspaceRoot, {
    home: deps.home,
    env: deps.env,
  });
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

  assertWithinRoot(deps, context.workspace, context.effective.config.workspaceRoot, options);

  return { context, backend: deps.backend() } as Opened<M>;
};
