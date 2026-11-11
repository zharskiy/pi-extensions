import { ENGINE_PROFILE } from "../../backend/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { busyLaunches } from "../launches.ts";
import { sweepOrphans } from "../sweep.ts";

export const stopCommand = async (deps: CliDeps) => {
  const stateDir = pathsOf(deps).stateDir;
  const outcome = await deps.backend().vm.stop({ busy: () => busyLaunches(stateDir) });

  if (outcome === "absent") {
    writeLine(deps.stdout, `no sandbox VM: the colima profile ${ENGINE_PROFILE} does not exist`);

    return 0;
  }

  if (outcome === "already stopped") {
    writeLine(deps.stdout, "the sandbox VM is already stopped");

    return 0;
  }

  const swept = await sweepOrphans(deps, undefined);

  writeLines(deps.stdout, [
    ...swept,
    `stopped the sandbox VM (profile ${ENGINE_PROFILE}); the next pi starts it again`,
  ]);

  return 0;
};
