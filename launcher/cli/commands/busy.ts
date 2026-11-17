import { liveLaunches } from "../../grants/index.ts";
import { type CliDeps, pathsOf, writeLine } from "../deps.ts";

export const BUSY = "__busy";

const SESSIONS_LIVE_EXIT = 75;

export const busyCommand = async (deps: CliDeps) => {
  const live = (await liveLaunches(pathsOf(deps).stateDir)).length;

  if (live === 0) {
    return 0;
  }

  writeLine(deps.stderr, `pi-sandbox: ${live} pi sessions still run in the sandbox`);

  return SESSIONS_LIVE_EXIT;
};
