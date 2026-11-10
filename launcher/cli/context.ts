import type { Backend } from "../backend/index.ts";
import { type EffectiveConfig, ignoredNotice, loadEffectiveConfig } from "../config/index.ts";
import { repoHash, stateLayout } from "../shared/index.ts";
import {
  assertSafeMounts,
  assertSafeWorkspace,
  assertWithinWorkspaceRoots,
  discoverWorkspace,
  type Workspace,
  workspaceFolder,
} from "../workspace/index.ts";
import { type CliDeps, pathsOf, writeLine } from "./deps.ts";
import { writeOnce } from "./notices.ts";

export interface LaunchContext {
  workspace: Workspace;
  effective: EffectiveConfig;
  stateDir: string;
  repoHash: string;
}

type ContextMode = "sandbox" | "host";

type Opened<M extends ContextMode> = M extends "host"
  ? { context: LaunchContext }
  : { context: LaunchContext; backend: Backend };

const discoverContext = async (deps: CliDeps, lenient: boolean): Promise<LaunchContext> => {
  const stateDir = pathsOf(deps).stateDir;
  const folder = await workspaceFolder(deps.cwd);
  const mounted = folder.root ?? folder.realCwd;

  if (!lenient) {
    assertSafeMounts([mounted], { home: deps.home, env: deps.env });
  }

  const effective = await loadEffectiveConfig({ repoRoot: mounted, env: deps.env });
  const workspace = await discoverWorkspace(folder, deps.runner, stateLayout(stateDir).emptyDir, {
    lenient,
    overlays: effective.config.mounts.autoOverlays,
  });
  const context = { workspace, effective, stateDir, repoHash: repoHash(workspace.repoRoot) };

  await writeOnce(deps, context, ignoredNotice(effective.ignored));

  return context;
};

export const checkWorkspaceRoots = (deps: CliDeps, context: LaunchContext) => {
  const roots = context.effective.config.workspaceRoots;

  if (assertWithinWorkspaceRoots(context.workspace, roots) === "warn") {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: ${context.workspace.repoRoot} is outside the workspace roots (${roots?.roots.join(", ")})`,
    );
  }
};

const checkWorkspace = (deps: CliDeps, context: LaunchContext) => {
  checkWorkspaceRoots(deps, context);

  assertSafeWorkspace(context.workspace, { home: deps.home, env: deps.env });
};

export const openContext = async <M extends ContextMode>(deps: CliDeps, mode: M): Promise<Opened<M>> => {
  const context = await discoverContext(deps, mode !== "sandbox");

  if (mode === "host") {
    return { context } as Opened<M>;
  }

  checkWorkspace(deps, context);

  return { context, backend: deps.backend() } as Opened<M>;
};
