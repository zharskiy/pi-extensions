import { type CommandRunner, PI_AGENT_DIR_VARIABLE } from "../../shared/index.ts";
import type { CachedSecret } from "./cache.ts";
import { commandSecret } from "./command.ts";
import { loginMissing, unavailable } from "./errors.ts";

const PI_AUTH_TTL_SECONDS = 240;

const piAuthArgv = (piCommand: string[], ref: { piAuth: string; bearer?: boolean }) => [
  ...piCommand,
  "auth",
  ref.bearer === true ? "print-bearer-token" : "print-api-key",
  "--provider",
  ref.piAuth,
  ...(ref.bearer === true ? ["--min-expiry", "5m"] : []),
];

export const piAuthSecret = (
  key: string,
  ref: { piAuth: string; bearer?: boolean },
  deps: { runner: CommandRunner; now: () => number; piCommand: string[]; hostAgentDir: string },
): Promise<CachedSecret> => {
  if (deps.piCommand.length === 0) {
    return Promise.reject(unavailable(`piAuth secret for ${key}: no pi command is configured`));
  }

  return commandSecret({
    key,
    kind: "piAuth",
    argv: piAuthArgv(deps.piCommand, ref),
    ttlSeconds: PI_AUTH_TTL_SECONDS,
    runner: deps.runner,
    now: deps.now,
    env: { [PI_AGENT_DIR_VARIABLE]: deps.hostAgentDir },
    exited: () => loginMissing(ref.piAuth),
  });
};
