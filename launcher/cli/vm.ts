import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, VmPath, VmShare, VmSpec, VmTarget } from "../backend/index.ts";
import { defaultVmMemoryProblem, type SandboxConfig, VM_BOUNDS } from "../config/index.ts";
import { isWithin, LauncherError, outermostPaths, realOrResolvedSync, stateLayout } from "../shared/index.ts";
import { type HostBind, type HostSessions, requiredRoot, sharedRootOf } from "../workspace/index.ts";
import { vmSessions } from "./busy.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeNotices } from "./deps.ts";
import { prepareSessionsDir } from "./host-sessions.ts";

export const writableMounts = (context: LaunchContext, sessions: HostSessions) => [
  context.mountedRoot,
  ...("dir" in sessions ? [sessions.dir] : []),
];

const vmPathsOf = (context: LaunchContext, sessions: HostSessions, binds: HostBind[]): VmPath[] =>
  [
    ...writableMounts(context, sessions).map((path) => ({ path, writable: true })),
    { path: stateLayout(context.stateDir).vm, writable: false },
    ...binds.map((bind) => ({ path: bind.share, writable: false })),
  ].map((need) => ({ ...need, path: realOrResolvedSync(need.path) }));

export interface VmSharePlan {
  root?: string;
  shares: VmShare[];
  notices: string[];
}

const HOST_RESERVE_GIB = 2;

export const rootPaths = (config: SandboxConfig) =>
  config.workspaceRoot === undefined ? [] : [config.workspaceRoot];

export const vmTargetOf = (vm: SandboxConfig["vm"]): VmTarget => {
  const size = { cpus: vm.cpus, memoryGiB: vm.memoryGiB, diskGiB: vm.diskGiB };

  return Object.fromEntries(Object.entries(size).filter(([, value]) => value !== undefined));
};

const AUTOMATIC = { cpus: { min: 2, max: 8 }, memoryGiB: { min: 4, max: 10 }, diskGiB: 60 };

export const clamp = (value: number, bounds: { min: number; max: number }) =>
  Math.max(bounds.min, Math.min(bounds.max, value));

export const hostVmLimits = (machine: CliDeps["machine"]) => ({
  cpus: clamp(machine.cpus, VM_BOUNDS.cpus),
  memoryGiB: clamp(Math.floor(machine.memoryGiB) - HOST_RESERVE_GIB, VM_BOUNDS.memoryGiB),
});

export const recommendedVmSize = (cpus: number, memoryGiB: number): VmSpec => ({
  cpus: clamp(Math.floor(cpus), AUTOMATIC.cpus),
  memoryGiB: clamp(Math.floor(memoryGiB / 2), AUTOMATIC.memoryGiB),
  diskGiB: AUTOMATIC.diskGiB,
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

export const assertMemoryFitsVm = (deps: CliDeps, config: SandboxConfig) => {
  if (config.vm.memoryGiB !== undefined) {
    return;
  }

  const size = recommendedVmSize(deps.machine.cpus, deps.machine.memoryGiB);
  const problem = defaultVmMemoryProblem(config, size.memoryGiB);

  if (problem !== undefined) {
    throw new LauncherError(
      `config: ${problem}`,
      `set vm.memoryGiB in ${pathsOf(deps).userConfigFile}, or run pi sandbox init to choose a size`,
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
      `config: workspaceRoot: the sandbox VM shares ${pair[0].location} and ${pair[1].location}, which nest, and colima refuses nested shares`,
      "keep <agent dir>/sessions and the launcher state dir apart from the workspace root",
    );
  }
};

const bindShares = (shares: VmShare[], binds: HostBind[]) =>
  outermostPaths(binds.map((bind) => bind.share))
    .filter((location) => !shares.some((share) => isWithin(location, share.location)))
    .map((location) => {
      const held = shares.find((share) => isWithin(share.location, location));

      if (held !== undefined) {
        throw new LauncherError(
          `config: mounts.binds: the sandbox VM would share ${location} for a bind source, which holds the share ${held.location}, and colima refuses nested shares`,
          "bind a folder inside that share, or one apart from it",
        );
      }

      return { location, writable: false };
    });

export const vmSharesFor = (
  deps: CliDeps,
  configured: string | undefined,
  binds: HostBind[],
): VmSharePlan => {
  const context = { home: deps.home, env: deps.env };
  const dirs = vmDirsOf(deps);
  const { root, notices } = sharedRootOf(requiredRoot(configured, context), context);
  const shares = [
    ...(root === undefined ? [] : [{ location: root, writable: true }]),
    { location: realOrResolvedSync(dirs.sessions), writable: true },
    { location: realOrResolvedSync(dirs.state), writable: false },
  ];

  assertApart(shares);

  return { root, shares: [...shares, ...bindShares(shares, binds)], notices };
};

export const prepareVmDirs = async (deps: CliDeps) => {
  const dirs = vmDirsOf(deps);

  await mkdir(dirs.sessions, { recursive: true, mode: 0o700 });

  await mkdir(dirs.state, { recursive: true });
};

export const prepareVmShares = async (deps: CliDeps, root: string | undefined, binds: HostBind[]) => {
  await prepareVmDirs(deps);

  return vmSharesFor(deps, root, binds);
};

const report = (deps: CliDeps) => (notice: string) => writeNotices(deps, [notice]);

export const startVm = async (
  backend: Backend,
  sessions: HostSessions,
  progress: (line: string) => void,
  start: { plan: VmSharePlan; size?: VmTarget },
) => {
  await prepareSessionsDir(sessions);

  await backend.vm.ensureRunning(
    (notice) => progress(`pi-sandbox: ${notice}`),
    start.plan.shares,
    start.size,
  );
};

const vmBusy = (context: LaunchContext, backend: Backend, launchId: string) => () =>
  vmSessions(backend, context.stateDir, launchId);

export const vmShareCoverage = (
  context: LaunchContext,
  backend: Backend,
  sessions: HostSessions,
  binds: HostBind[],
) => backend.vm.coverage(vmPathsOf(context, sessions, binds));

export const reconcileVm = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { sessions: HostSessions; launchId: string; plan: VmSharePlan; binds: HostBind[] },
) => {
  writeNotices(deps, parts.plan.notices);

  await backend.vm.reconcile(
    {
      size: vmTargetOf(context.effective.config.vm),
      shares: parts.plan.shares,
      needs: vmPathsOf(context, parts.sessions, parts.binds),
    },
    { busy: vmBusy(context, backend, parts.launchId), report: report(deps) },
  );
};

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
