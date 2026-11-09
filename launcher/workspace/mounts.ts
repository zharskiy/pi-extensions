import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { HostCachePreset } from "../config/index.ts";
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

interface HostCacheContext extends ProtectedContext {
  sharedCaches: string[];
}

interface CacheDir {
  host: string;
  guest: string;
}

export interface HostCache {
  preset: HostCachePreset;
  source: string;
  target: string;
}

const same = (path: string): CacheDir => ({ host: path, guest: path });

const HOST_CACHES: Record<HostCachePreset, CacheDir[]> = {
  maven: [same(".m2/repository")],
  gradle: [same(".gradle/caches"), same(".gradle/wrapper")],
  npm: [same(".npm/_cacache")],
  pip: [{ host: "Library/Caches/pip", guest: ".cache/pip" }],
  go: [same("go/pkg/mod")],
  cargo: [same(".cargo/registry"), same(".cargo/git")],
};

const CREDENTIAL_NAMES = [
  "settings.xml",
  "settings-security.xml",
  "gradle.properties",
  "init.d",
  ".npmrc",
  ".pypirc",
  "pip.conf",
  "credentials",
  "credentials.toml",
  "config.toml",
  ".netrc",
  ".git-credentials",
];

const CACHE_DIR_MODE = 0o700;

const cacheDirsOf = (presets: HostCachePreset[]) =>
  [...new Set(presets)].flatMap((preset) => HOST_CACHES[preset].map((dir) => ({ preset, ...dir })));

export const hostCachePaths = (presets: HostCachePreset[], home: string) =>
  cacheDirsOf(presets).map((dir) => join(home, dir.host));

const lstatQuiet = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

const realOf = (path: string): string => {
  if (lstatQuiet(path) === undefined) {
    return join(realOf(dirname(path)), basename(path));
  }

  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

const isCredentialName = (name: string) => CREDENTIAL_NAMES.includes(name) || name.startsWith("credentials");

const credentialReason = (real: string) => {
  const found = readdirSync(real).find(isCredentialName);

  return found === undefined ? undefined : `it holds ${found}`;
};

const homeReason = (real: string, home: string) =>
  real !== home && isWithin(real, home) ? undefined : "it resolves outside the home directory";

const sharedReason = (guest: string, sharedCaches: string[]) => {
  const shared = sharedCaches
    .map((entry) => entry.slice(2).replace(/\/+$/, ""))
    .find((entry) => isWithin(entry, guest));

  return shared === undefined ? undefined : `~/${shared} is also in mounts.sharedCaches`;
};

const entryReason = (path: string, real: string, guard: PathGuard, home: string) => {
  const info = lstatQuiet(path);
  const found = guard(real) ?? homeReason(real, home) ?? gitReason(real, "directory");

  if (found !== undefined || info === undefined) {
    return found;
  }

  if (info.isSymbolicLink()) {
    return "it is a symbolic link";
  }

  return info.isDirectory() ? credentialReason(real) : "it is not a directory";
};

const checkedCaches = (presets: HostCachePreset[], context: HostCacheContext) => {
  const guard = guardOf(protectedPaths(context));
  const home = realOrResolvedSync(context.home);

  return cacheDirsOf(presets).map((dir) => {
    const path = join(context.home, dir.host);
    const real = realOf(path);
    const found = sharedReason(dir.guest, context.sharedCaches) ?? entryReason(path, real, guard, home);

    if (found !== undefined) {
      throw new LauncherError(
        `mounts.hostCaches: ${dir.preset} (~/${dir.host}) is not allowed (${found})`,
        `remove ${dir.preset} from mounts.hostCaches`,
      );
    }

    return { preset: dir.preset, path, source: real, target: dir.guest };
  });
};

export const createHostCacheDirs = (presets: HostCachePreset[], context: HostCacheContext) =>
  checkedCaches(presets, context)
    .filter((cache) => !existsSync(cache.path))
    .map((cache) => {
      mkdirSync(cache.path, { recursive: true, mode: CACHE_DIR_MODE });

      return cache.path;
    });

export const resolveHostCaches = (presets: HostCachePreset[], context: HostCacheContext): HostCache[] =>
  checkedCaches(presets, context).map((cache) => {
    if (!existsSync(cache.path)) {
      throw new LauncherError(
        `mounts.hostCaches: ${cache.preset} (${cache.path}) does not exist`,
        "run pi again so the launcher creates it",
      );
    }

    return { preset: cache.preset, source: cache.source, target: cache.target };
  });
