import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, VmPath, VmShare } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { realOrResolvedSync, stateLayout } from "../shared/index.ts";
import { type HostSessions, mountedGitDirs, sharedRootsOf } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeNotices } from "./deps.ts";
import { prepareSessionsDir } from "./host-sessions.ts";
import { busyLaunches } from "./launches.ts";

const vmPathsOf = (context: LaunchContext, sessions: HostSessions): VmPath[] =>
  [
    ...mountedGitDirs(context.workspace).map((path) => ({ path, writable: true })),
    { path: stateLayout(context.stateDir).vm, writable: false },
    ...("dir" in sessions ? [{ path: sessions.dir, writable: true }] : []),
  ].map((need) => ({ ...need, path: realOrResolvedSync(need.path) }));

type WorkspaceRoots = SandboxConfig["workspaceRoots"];

export interface VmSharePlan {
  shares: VmShare[];
  notices: string[];
}

const vmDirsOf = (deps: CliDeps) => ({
  sessions: join(hostAgentDirOf(deps), "sessions"),
  state: stateLayout(pathsOf(deps).stateDir).vm,
});

export const vmSharesFor = (deps: CliDeps, workspaceRoots: WorkspaceRoots): VmSharePlan | undefined => {
  if (workspaceRoots === undefined) {
    return undefined;
  }

  const dirs = vmDirsOf(deps);
  const guard = { home: deps.home, agentDir: hostAgentDirOf(deps), stateDir: pathsOf(deps).stateDir };
  const { roots, notices } = sharedRootsOf(workspaceRoots, guard);
  const shares = [
    ...roots.map((location) => ({ location, writable: true })),
    { location: realOrResolvedSync(dirs.sessions), writable: true },
    { location: realOrResolvedSync(dirs.state), writable: false },
  ];

  return { shares, notices };
};

export const prepareVmShares = async (deps: CliDeps, workspaceRoots: WorkspaceRoots) => {
  if (workspaceRoots === undefined) {
    return undefined;
  }

  const dirs = vmDirsOf(deps);

  await mkdir(dirs.sessions, { recursive: true, mode: 0o700 });

  await mkdir(dirs.state, { recursive: true });

  return vmSharesFor(deps, workspaceRoots);
};

const report = (deps: CliDeps) => (notice: string) => writeNotices(deps, [notice]);

export const startVm = async (backend: Backend, sessions: HostSessions, progress: (line: string) => void) => {
  await prepareSessionsDir(sessions);

  await backend.vm.ensureRunning((notice) => progress(`pi-sandbox: ${notice}`));
};

export const vmShareCoverage = (
  _deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  sessions: HostSessions,
) => backend.vm.coverage(vmPathsOf(context, sessions));

export const shareVm = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { sessions: HostSessions; launchId: string },
) => {
  const plan = await prepareVmShares(deps, context.effective.config.workspaceRoots);
  const needs = vmPathsOf(context, parts.sessions);
  const options = { busy: () => busyLaunches(context.stateDir, parts.launchId), report: report(deps) };

  if (plan === undefined) {
    await backend.vm.ensureShares(needs, options);

    return;
  }

  writeNotices(deps, plan.notices);

  await backend.vm.reconcileShares(plan.shares, needs, options);
};

export const trustVm = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { extraPemPath: string; launchId: string },
) =>
  backend.vm.ensureTrust(parts.extraPemPath, {
    busy: () => busyLaunches(context.stateDir, parts.launchId),
    report: report(deps),
  });
