import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface SocketContext {
  env: NodeJS.ProcessEnv;
  home: string;
  exists?: (path: string) => boolean;
}

const UNIX_PREFIX = "unix://";

const SYSTEM_SOCKET = "/var/run/docker.sock";

const COLIMA_PROFILES = ["pi-sandbox", "default"];

const colimaRoot = (home: string) => join(home, ".colima");

const dockerHostSocket = (env: NodeJS.ProcessEnv) => {
  const host = env.DOCKER_HOST;

  return host?.startsWith(UNIX_PREFIX) ? host.slice(UNIX_PREFIX.length) : undefined;
};

export const resolveDockerSocket = (context: SocketContext) => {
  const exists = context.exists ?? existsSync;
  const colimaSockets = COLIMA_PROFILES.map((profile) =>
    join(colimaRoot(context.home), profile, "docker.sock"),
  );

  return dockerHostSocket(context.env) ?? colimaSockets.find(exists) ?? SYSTEM_SOCKET;
};

export const colimaProfileOf = (socketPath: string, home: string) => {
  const profileDir = dirname(socketPath);

  return dirname(profileDir) === colimaRoot(home) ? basename(profileDir) : undefined;
};
