import type { Backend, VmPath } from "../backend/index.ts";
import { realOrResolvedSync } from "../shared/index.ts";
import { type HostSessions, mountedGitDirs } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, writeNotices } from "./deps.ts";
import { prepareSessionsDir } from "./host-sessions.ts";
import { busyLaunches } from "./launches.ts";

const vmPathsOf = (context: LaunchContext, sessions: HostSessions): VmPath[] =>
  [
    ...mountedGitDirs(context.workspace).map((path) => ({ path, writable: true })),
    { path: context.stateDir, writable: false },
    ...("dir" in sessions ? [{ path: sessions.dir, writable: true }] : []),
  ].map((need) => ({ ...need, path: realOrResolvedSync(need.path) }));

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

export const shareVm = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { sessions: HostSessions; launchId: string },
) =>
  backend.vm.ensureShares(vmPathsOf(context, parts.sessions), {
    busy: () => busyLaunches(context.stateDir, parts.launchId),
    report: report(deps),
  });

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
