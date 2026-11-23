import { ENGINE_PROFILE } from "../../backend/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf, writeLines } from "../deps.ts";
import { sweepOrphans } from "../sweep.ts";

const STOPPED = {
  absent: `no sandbox VM: the colima profile ${ENGINE_PROFILE} does not exist`,
  "already stopped": "the sandbox VM is already stopped",
  stopped: `stopped the sandbox VM (profile ${ENGINE_PROFILE}); the next pi starts it again`,
};

export const stopCommand = async (deps: CliDeps) => {
  const backend = deps.backend();
  const swept = await sweepOrphans(deps, backend);
  const stateDir = pathsOf(deps).stateDir;
  const outcome = await backend.vm.stop({ busy: () => vmSessions(backend, stateDir) });

  writeLines(deps.stdout, [...swept, STOPPED[outcome]]);

  return 0;
};
