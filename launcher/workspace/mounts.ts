import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  expandHome,
  hostAgentDir,
  isWithin,
  LauncherError,
  launcherPaths,
  realOrResolvedSync,
} from "../shared/index.ts";

interface ProtectedContext {
  home: string;
  env: NodeJS.ProcessEnv;
  engineSockets?: string[];
}

interface ExtraMountContext extends ProtectedContext {
  repoRoot: string;
}

export interface Protected {
  path: string;
  reason: string;
  under: boolean;
}

const PROTECTED_HOME = [".ssh", ".gnupg", ".aws", ".docker", ".colima", ".kube"];

const SYSTEM_DIRS = ["/var/run", "/run", "/etc", "/proc", "/sys", "/dev"];

const DEFAULT_CONFIG_DIR = [".config", "pi-sandbox"];

const dockerHostSocket = (env: NodeJS.ProcessEnv) => {
  const host = env.DOCKER_HOST;

  return host?.startsWith("unix://") ? host.slice("unix://".length) : undefined;
};

const userConfigOf = (home: string, userConfigFile: string) => {
  const defaultDir = resolve(home, ...DEFAULT_CONFIG_DIR);

  return resolve(dirname(userConfigFile)) === defaultDir ? defaultDir : userConfigFile;
};

export const protectedPaths = (context: ProtectedContext): Protected[] => {
  const paths = launcherPaths({ env: context.env, home: context.home });
  const sockets = [dockerHostSocket(context.env), ...(context.engineSockets ?? [])].filter(
    (path) => path !== undefined,
  );
  const listed = [
    { path: context.home, reason: "the home directory", under: false },
    { path: join(context.home, ".pi"), reason: "pi's directory", under: true },
    { path: hostAgentDir(context.home, context.env), reason: "pi's agent directory", under: true },
    { path: paths.stateDir, reason: "the launcher state directory", under: true },
    {
      path: userConfigOf(context.home, paths.userConfigFile),
      reason: "the launcher user config",
      under: true,
    },
    ...PROTECTED_HOME.map((name) => ({ path: join(context.home, name), reason: `~/${name}`, under: true })),
    ...SYSTEM_DIRS.map((path) => ({ path, reason: path, under: true })),
    ...sockets.map((path) => ({ path, reason: "the container engine socket", under: true })),
  ];

  return listed.flatMap((entry) => {
    const real = realOrResolvedSync(entry.path);
    const resolved = resolve(entry.path);

    return real === resolved ? [{ ...entry, path: real }] : [entry, { ...entry, path: real }];
  });
};

const refuse = (path: string, reason: string) =>
  new LauncherError(
    `mounts.extraReadOnly: ${path} is not allowed (${reason})`,
    "remove it from mounts.extraReadOnly",
  );

const kindOf = (path: string) => {
  const info = statSync(path, { throwIfNoEntry: false });

  if (info === undefined) {
    return "missing";
  }

  return info.isFile() || info.isDirectory() ? (info.isDirectory() ? "directory" : "file") : "special";
};

const conflictOf = (real: string, entry: Protected) => {
  if (isWithin(entry.path, real)) {
    return real === entry.path ? `it is ${entry.reason}` : `it contains ${entry.reason}`;
  }

  return entry.under && isWithin(real, entry.path) ? `it is inside ${entry.reason}` : undefined;
};

const gitReason = (real: string, kind: string) => {
  if (real.split(sep).includes(".git")) {
    return "it is inside a .git directory";
  }

  return kind === "directory" && existsSync(join(real, ".git")) ? "it contains a .git directory" : undefined;
};

type PathGuard = (path: string) => string | undefined;

const guardOf =
  (guarded: Protected[]): PathGuard =>
  (real) =>
    guarded.map((entry) => conflictOf(real, entry)).find((found) => found !== undefined);

const checkedMount = (given: string, context: ExtraMountContext, guard: PathGuard) => {
  const expanded = expandHome(given, context.home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(context.repoRoot, expanded);
  const kind = kindOf(absolute);

  if (kind === "missing") {
    throw refuse(given, "it does not exist");
  }

  if (kind === "special") {
    throw refuse(given, "it is not a regular file or directory");
  }

  const real = realpathSync.native(absolute);
  const found = guard(real) ?? gitReason(real, kind);

  if (found !== undefined) {
    throw refuse(given, found);
  }

  return { source: real, target: absolute };
};

export const protectedRealPathGuard = (context: ExtraMountContext) => guardOf(protectedPaths(context));

export const resolveExtraMounts = (paths: string[], context: ExtraMountContext) => {
  const guard = protectedRealPathGuard(context);

  return paths.map((path) => checkedMount(path, context, guard));
};
