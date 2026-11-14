import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Backend, LABELS, type VmPath, type VmShare, type VmTarget } from "../backend/index.ts";
import { type SandboxConfig, VM_BOUNDS } from "../config/index.ts";
import { listLauncherContainers } from "../container/index.ts";
import { liveLaunches } from "../grants/index.ts";
import { isWithin, LauncherError, realOrResolvedSync, stateLayout } from "../shared/index.ts";
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

const HOST_RESERVE_GIB = 2;

export const hostVmLimits = (machine: CliDeps["machine"]) => ({
  cpus: Math.min(VM_BOUNDS.cpus.max, Math.max(VM_BOUNDS.cpus.min, machine.cpus)),
  memoryGiB: Math.min(
    VM_BOUNDS.memoryGiB.max,
    Math.max(VM_BOUNDS.memoryGiB.min, Math.floor(machine.memoryGiB) - HOST_RESERVE_GIB),
  ),
});

const vmHostProblems = (machine: CliDeps["machine"], target: VmTarget) => {
  const limits = hostVmLimits(machine);
  const memory = Math.floor(machine.memoryGiB);

  return [
    ...(target.cpus !== undefined && target.cpus > limits.cpus
      ? [`config: vm.cpus ${target.cpus} is more than the ${machine.cpus} CPUs of this Mac`]
      : []),
    ...(target.memoryGiB !== undefined && target.memoryGiB > limits.memoryGiB
      ? [
          `config: vm.memoryGiB ${target.memoryGiB} is more than the ${limits.memoryGiB} GiB this Mac can give the VM (${memory} GiB, less ${HOST_RESERVE_GIB} for macOS)`,
        ]
      : []),
  ];
};

export const assertVmFitsHost = (deps: CliDeps, target: VmTarget) => {
  const problems = vmHostProblems(deps.machine, target);

  if (problems.length > 0) {
    throw new LauncherError(
      problems.join("; "),
      `lower it in ${pathsOf(deps).userConfigFile}, or run pi sandbox init to choose a size`,
    );
  }
};

const vmDirsOf = (deps: CliDeps) => ({
  sessions: join(hostAgentDirOf(deps), "sessions"),
  state: stateLayout(pathsOf(deps).stateDir).vm,
});

const nestedPair = (shares: VmShare[]) =>
  shares
    .flatMap((share, index) => shares.slice(index + 1).map((other) => [share, other] as const))
    .find(
      ([share, other]) =>
        isWithin(share.location, other.location) || isWithin(other.location, share.location),
    );

const assertApart = (shares: VmShare[]) => {
  const pair = nestedPair(shares);

  if (pair !== undefined) {
    throw new LauncherError(
      `config: workspaceRoots: the sandbox VM shares ${pair[0].location} and ${pair[1].location}, which nest, and colima refuses nested shares`,
      "keep <agent dir>/sessions and the launcher state dir outside every workspace root, and the roots apart from each other",
    );
  }
};

export const vmSharesFor = (deps: CliDeps, workspaceRoots: WorkspaceRoots): VmSharePlan | undefined => {
  if (workspaceRoots === undefined) {
    return undefined;
  }

  const dirs = vmDirsOf(deps);
  const { roots, notices } = sharedRootsOf(workspaceRoots, { home: deps.home, env: deps.env });
  const shares = [
    ...roots.map((location) => ({ location, writable: true })),
    { location: realOrResolvedSync(dirs.sessions), writable: true },
    { location: realOrResolvedSync(dirs.state), writable: false },
  ];

  assertApart(shares);

  return { shares, notices };
};

export const prepareVmDirs = async (deps: CliDeps) => {
  const dirs = vmDirsOf(deps);

  await mkdir(dirs.sessions, { recursive: true, mode: 0o700 });

  await mkdir(dirs.state, { recursive: true });
};

export const prepareVmShares = async (deps: CliDeps, workspaceRoots: WorkspaceRoots) => {
  if (workspaceRoots === undefined) {
    return undefined;
  }

  await prepareVmDirs(deps);

  return vmSharesFor(deps, workspaceRoots);
};

const report = (deps: CliDeps) => (notice: string) => writeNotices(deps, [notice]);

export const startVm = async (
  backend: Backend,
  sessions: HostSessions,
  progress: (line: string) => void,
  start: { plan?: VmSharePlan; size?: VmTarget } = {},
) => {
  await prepareSessionsDir(sessions);

  await backend.vm.ensureRunning(
    (notice) => progress(`pi-sandbox: ${notice}`),
    start.plan?.shares,
    start.size,
  );
};

const foreignSessions = async (backend: Backend, stateDir: string, launchId?: string) => {
  if (!(await backend.detect()).available) {
    return 0;
  }

  const live = (await liveLaunches(stateDir)).map((launch) => launch.launchId);
  const known = new Set([...(launchId === undefined ? [] : [launchId]), ...live]);
  const containers = await listLauncherContainers(backend);

  return containers.filter(
    (container) => container.state === "running" && !known.has(container.labels[LABELS.launchId] ?? ""),
  ).length;
};

const busyCount = async (backend: Backend, stateDir: string, launchId?: string) =>
  (await busyLaunches(stateDir, launchId)) + (await foreignSessions(backend, stateDir, launchId));

export const vmBusyCount = (backend: Backend, stateDir: string) => busyCount(backend, stateDir);

const vmBusy = (context: LaunchContext, backend: Backend, launchId: string) => () =>
  busyCount(backend, context.stateDir, launchId);

export const vmShareCoverage = (context: LaunchContext, backend: Backend, sessions: HostSessions) =>
  backend.vm.coverage(vmPathsOf(context, sessions));

export const shareVm = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { sessions: HostSessions; launchId: string; plan: VmSharePlan | undefined },
) => {
  const needs = vmPathsOf(context, parts.sessions);
  const options = {
    busy: vmBusy(context, backend, parts.launchId),
    report: report(deps),
    size: context.effective.config.vm,
  };

  if (parts.plan === undefined) {
    await backend.vm.ensureShares(needs, options);

    return;
  }

  writeNotices(deps, parts.plan.notices);

  await backend.vm.reconcileShares(parts.plan.shares, needs, options);
};

export const sizeVm = (deps: CliDeps, context: LaunchContext, backend: Backend, launchId: string) =>
  backend.vm.ensureSize(context.effective.config.vm, {
    busy: vmBusy(context, backend, launchId),
    report: report(deps),
  });

export const trustVm = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { extraPemPath: string; launchId: string },
) =>
  backend.vm.ensureTrust(parts.extraPemPath, {
    busy: vmBusy(context, backend, parts.launchId),
    report: report(deps),
  });
