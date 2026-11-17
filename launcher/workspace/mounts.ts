import { join, resolve } from "node:path";
import {
  hostAgentDir,
  isWithin,
  launcherPaths,
  PRIVATE_HOME_DIRS,
  realOrResolvedSync,
} from "../shared/index.ts";

interface ProtectedContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

export interface Protected {
  path: string;
  reason: string;
  under: boolean;
}

const SYSTEM_DIRS = ["/var/run", "/run", "/etc", "/proc", "/sys", "/dev"];

const IMAGE_DIRS = ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/local", "/bin", "/sbin", "/lib", "/opt"];

const dockerHostSocket = (env: NodeJS.ProcessEnv) => {
  const host = env.DOCKER_HOST;

  return host?.startsWith("unix://") ? host.slice("unix://".length) : undefined;
};

export const protectedPaths = (context: ProtectedContext): Protected[] => {
  const paths = launcherPaths({ env: context.env, home: context.home });
  const socket = dockerHostSocket(context.env);
  const listed = [
    { path: context.home, reason: "the home directory", under: false },
    { path: join(context.home, ".pi"), reason: "pi's directory", under: true },
    { path: hostAgentDir(context.home, context.env), reason: "pi's agent directory", under: true },
    { path: paths.stateDir, reason: "the launcher state directory", under: true },
    { path: paths.userConfigFile, reason: "the launcher user config", under: true },
    { path: join(context.home, ".config"), reason: "~/.config", under: false },
    { path: join(context.home, ".config", "pi-sandbox"), reason: "~/.config/pi-sandbox", under: true },
    ...PRIVATE_HOME_DIRS.map((name) => ({
      path: join(context.home, name),
      reason: `~/${name}`,
      under: true,
    })),
    ...SYSTEM_DIRS.map((path) => ({ path, reason: path, under: true })),
    ...IMAGE_DIRS.map((path) => ({ path, reason: `${path}, which the sandbox image uses`, under: false })),
    ...(socket === undefined ? [] : [{ path: socket, reason: "the container engine socket", under: true }]),
  ];

  return listed.flatMap(withRealForm);
};

export const withRealForm = (entry: Protected): Protected[] => {
  const real = realOrResolvedSync(entry.path);

  return real === resolve(entry.path) ? [{ ...entry, path: real }] : [entry, { ...entry, path: real }];
};

export type Overlap = "is" | "contains" | "inside";

export const overlapOf = (path: string, entry: Pick<Protected, "path" | "under">): Overlap | undefined => {
  if (isWithin(entry.path, path)) {
    return path === entry.path ? "is" : "contains";
  }

  return entry.under && isWithin(path, entry.path) ? "inside" : undefined;
};
