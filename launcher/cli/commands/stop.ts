import { ENGINE_PROFILE } from "../../backend/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { busyLaunches } from "../launches.ts";

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

  const instances = await deps.proxy.list(stateDir);

  await deps.proxy.stop(stateDir);

  writeLines(deps.stdout, [
    ...instances.map((instance) => `stopped proxy pid ${instance.pid} port ${instance.port}`),
    `stopped the sandbox VM (profile ${ENGINE_PROFILE}); the next pi starts it again`,
  ]);

  return 0;
};
