import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Backend, engineSocketPath, type VmPath } from "../backend/index.ts";
import { expandHome, realOrResolvedSync, stateLayout } from "../shared/index.ts";
import {
  createHostCacheDirs,
  type HostSessions,
  hostCachePaths,
  mountedGitDirs,
} from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, withFallbackHint, writeNotices } from "./deps.ts";
import { prepareSessionsDir } from "./host-sessions.ts";
import { busyLaunches } from "./launches.ts";

export const hostCacheContext = (deps: CliDeps, context: LaunchContext) => ({
  home: deps.home,
  env: deps.env,
  engineSockets: [engineSocketPath(deps.home)],
  sharedCaches: context.effective.config.mounts.sharedCaches,
});

const vmPathsOf = (deps: CliDeps, context: LaunchContext, sessions: HostSessions): VmPath[] => {
  const { workspace, effective } = context;
  const sessionsDir = "dir" in sessions ? [{ path: sessions.dir, writable: true }] : [];

  return [
    ...mountedGitDirs(workspace).map((path) => ({ path, writable: true })),
    { path: context.stateDir, writable: false },
    ...effective.config.mounts.extraReadOnly.map((path) => ({
      path: resolve(workspace.repoRoot, expandHome(path, deps.home)),
      writable: false,
    })),
    ...sessionsDir,
    ...hostCachePaths(effective.config.mounts.hostCaches, deps.home).map((path) => ({
      path,
      writable: true,
    })),
  ].map((need) => ({ ...need, path: realOrResolvedSync(need.path) }));
};

const withHint = async <T>(context: LaunchContext, action: () => Promise<T>) => {
  try {
    return await action();
  } catch (error) {
    throw withFallbackHint(error, context.effective.config.fallback);
  }
};

const prepareMaskSource = async (context: LaunchContext) => {
  if ((context.workspace.masked ?? []).length > 0) {
    await mkdir(stateLayout(context.stateDir).emptyDir, { recursive: true, mode: 0o700 });
  }
};

const prepareHostPaths = async (deps: CliDeps, context: LaunchContext, sessions: HostSessions) => {
  const created = createHostCacheDirs(
    context.effective.config.mounts.hostCaches,
    hostCacheContext(deps, context),
  );

  writeNotices(
    deps,
    created.map((path) => `created ${path} for mounts.hostCaches`),
  );

  await prepareSessionsDir(sessions);

  await prepareMaskSource(context);
};

const report = (deps: CliDeps) => (notice: string) => writeNotices(deps, [notice]);

export const startVm = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { sessions: HostSessions; share: boolean },
) =>
  withHint(context, async () => {
    await prepareHostPaths(deps, context, parts.sessions);

    await (parts.share
      ? backend.vm.ensureRunning(report(deps), vmPathsOf(deps, context, parts.sessions))
      : backend.vm.ensureRunning(report(deps)));
  });

export const vmShareCoverage = (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  sessions: HostSessions,
) => backend.vm.coverage(vmPathsOf(deps, context, sessions));

export const shareVm = (deps: CliDeps, context: LaunchContext, backend: Backend, sessions: HostSessions) =>
  withHint(context, () =>
    backend.vm.ensureShares(vmPathsOf(deps, context, sessions), {
      busy: () => busyLaunches(context.stateDir),
      report: report(deps),
    }),
  );
