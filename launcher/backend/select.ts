import { BACKEND_NAMES, type CommandRunner, LauncherError } from "../shared/index.ts";
import { createAppleBackend } from "./apple/backend.ts";
import { createDockerEngineBackend } from "./docker-engine/backend.ts";
import { resolveDockerSocket } from "./docker-engine/socket.ts";
import type { Backend, BackendName } from "./types.ts";

export type BackendPreference = "auto" | BackendName;

interface DefaultAdapterContext {
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  home: string;
}

interface Attempt {
  name: BackendName;
  reason: string;
}

const candidatesFor = (preference: BackendPreference) =>
  preference === "auto" ? [...BACKEND_NAMES] : [preference];

const firstAvailable = async (
  names: BackendName[],
  adapters: Backend[],
  attempts: Attempt[] = [],
): Promise<Backend | Attempt[]> => {
  const [name, ...rest] = names;

  if (name === undefined) {
    return attempts;
  }

  const adapter = adapters.find((candidate) => candidate.name === name);

  if (adapter === undefined) {
    return firstAvailable(rest, adapters, [...attempts, { name, reason: "no adapter on this host" }]);
  }

  const detection = await adapter.detect();

  if (detection.available) {
    return adapter;
  }

  return firstAvailable(rest, adapters, [...attempts, { name, reason: detection.reason ?? "unavailable" }]);
};

export const selectBackend = async (preference: BackendPreference, adapters: Backend[]) => {
  const selected = await firstAvailable(candidatesFor(preference), adapters);

  if (!Array.isArray(selected)) {
    return selected;
  }

  const tried = selected.map((attempt) => `${attempt.name} (${attempt.reason})`).join("; ");

  throw new LauncherError(
    `no sandbox backend available: ${tried}`,
    "run launcher/install.sh or start the runtime (colima start --profile pi-sandbox, container system start)",
  );
};

export const createDefaultAdapters = (context: DefaultAdapterContext): Backend[] => [
  createDockerEngineBackend({
    socketPath: resolveDockerSocket({ env: context.env, home: context.home }),
    runner: context.runner,
    home: context.home,
  }),
  createAppleBackend({ runner: context.runner }),
];
