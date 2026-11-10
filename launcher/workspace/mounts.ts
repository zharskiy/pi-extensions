import { dirname, join, resolve } from "node:path";
import { hostAgentDir, isWithin, launcherPaths, realOrResolvedSync } from "../shared/index.ts";

interface ProtectedContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

export interface Protected {
  path: string;
  reason: string;
  under: boolean;
}

const PROTECTED_HOME = [".ssh", ".gnupg", ".aws", ".docker", ".colima", ".kube"];

const SYSTEM_DIRS = ["/var/run", "/run", "/etc", "/proc", "/sys", "/dev"];

const IMAGE_DIRS = ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/local", "/bin", "/sbin", "/lib", "/opt"];

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
  const socket = dockerHostSocket(context.env);
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
    ...IMAGE_DIRS.map((path) => ({ path, reason: `${path}, which the sandbox image uses`, under: false })),
    ...(socket === undefined ? [] : [{ path: socket, reason: "the container engine socket", under: true }]),
  ];

  return listed.flatMap((entry) => {
    const real = realOrResolvedSync(entry.path);
    const resolved = resolve(entry.path);

    return real === resolved ? [{ ...entry, path: real }] : [entry, { ...entry, path: real }];
  });
};

const conflictOf = (real: string, entry: Protected) => {
  if (isWithin(entry.path, real)) {
    return real === entry.path ? `it is ${entry.reason}` : `it contains ${entry.reason}`;
  }

  return entry.under && isWithin(real, entry.path) ? `it is inside ${entry.reason}` : undefined;
};

export const protectedRealPathGuard = (context: ProtectedContext) => {
  const guarded = protectedPaths(context);

  return (real: string) =>
    guarded.map((entry) => conflictOf(real, entry)).find((found) => found !== undefined);
};
