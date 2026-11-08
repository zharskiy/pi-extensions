import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostAgentDir, isWithin, LauncherError, launcherPaths, realOrResolvedSync } from "../shared/index.ts";
import { sessionSlug } from "./pi-session-dir.ts";
import type { Workspace } from "./types.ts";

interface GuardContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const DEFAULT_CONFIG_DIR = [".config", "pi-sandbox"];

const protectedConfig = (context: GuardContext, userConfigFile: string) => {
  const defaultDir = resolve(context.home, ...DEFAULT_CONFIG_DIR);

  return resolve(dirname(userConfigFile)) === defaultDir ? defaultDir : userConfigFile;
};

const launcherDirs = (context: GuardContext) => {
  const paths = launcherPaths(context);

  return [
    join(context.home, ".pi"),
    hostAgentDir(context.home, context.env),
    paths.stateDir,
    protectedConfig(context, paths.userConfigFile),
  ].map(realOrResolvedSync);
};

const HINT = "run pi inside a project directory";

const assertOutsideLauncherDirs = (mounted: string[], context: GuardContext) => {
  const dirs = launcherDirs(context);
  const inside = mounted.find((path) => dirs.some((dir) => isWithin(path, dir)));

  if (inside === undefined) {
    return;
  }

  const container = dirs.find((dir) => isWithin(inside, dir));

  throw new LauncherError(`${inside} is inside ${container}, refusing to mount it into the sandbox`, HINT);
};

export const assertSafeWorkspace = (workspace: Workspace, context: GuardContext) => {
  const dirs = ["/", context.home].map(realOrResolvedSync).concat(launcherDirs(context));
  const mounted = [workspace.repoRoot, workspace.gitCommonDir].filter((path) => path !== undefined);
  const unsafe = mounted.find((path) => dirs.some((dir) => isWithin(dir, path)));

  if (unsafe === undefined) {
    assertOutsideLauncherDirs(mounted, context);

    return;
  }

  const covered = dirs.find((dir) => isWithin(dir, unsafe));

  throw new LauncherError(`${unsafe} would mount ${covered} into the sandbox, refusing`, HINT);
};

interface HostSessionsContext {
  home: string;
  agentDir: string;
  repoRoot: string;
}

const SLUG = /^--[^/]*--$/;

const SESSIONS_HINT = "set sessions.host to false in the user config";

const refuseSessions = (dir: string, reason: string) =>
  new LauncherError(`sessions: ${dir} ${reason}, refusing to mount it into the sandbox`, SESSIONS_HINT);

const realSessionsDir = (sessions: string) => {
  try {
    return realpathSync.native(sessions);
  } catch {
    return undefined;
  }
};

const agentEntries = (agentDir: string) => {
  try {
    return readdirSync(agentDir).filter((name) => name !== "sessions");
  } catch {
    return [];
  }
};

const protectedPiPaths = (context: HostSessionsContext) => {
  const agentDir = resolve(context.agentDir);

  return [
    { path: realOrResolvedSync(join(context.home, ".pi")), both: false },
    { path: realOrResolvedSync(agentDir), both: false },
    ...agentEntries(agentDir).map((name) => ({ path: realOrResolvedSync(join(agentDir, name)), both: true })),
  ];
};

export const assertHostSessionsDir = (dir: string, context: HostSessionsContext) => {
  const sessions = join(resolve(context.agentDir), "sessions");
  const slug = sessionSlug(context.repoRoot);

  if (!SLUG.test(slug) || dir !== join(sessions, slug)) {
    throw refuseSessions(dir, "is not pi's session directory of this repository");
  }

  const info = lstatSync(dir, { throwIfNoEntry: false });

  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw refuseSessions(dir, "is not a real directory");
  }

  const realSessions = realSessionsDir(sessions);

  const real = realOrResolvedSync(dir);

  if (realSessions === undefined || real !== join(realSessions, slug)) {
    throw refuseSessions(dir, "resolves outside pi's sessions directory");
  }

  const overlap = protectedPiPaths(context).find(
    ({ path, both }) => isWithin(path, real) || (both && isWithin(real, path)),
  );

  if (overlap !== undefined) {
    throw refuseSessions(dir, `resolves to a path that overlaps ${overlap.path}`);
  }
};
