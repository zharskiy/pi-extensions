import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { stepsOf } from "../steps.ts";
import { sweepOrphans } from "../sweep.ts";

const NOTHING_TO_STOP = {
  absent: "There is no sandbox VM to stop.",
  "already stopped": "The sandbox VM is already stopped.",
};

export const stopCommand = async (deps: CliDeps) => {
  const backend = deps.backend();
  const steps = stepsOf(deps);
  const swept = await sweepOrphans(deps, backend);
  const stateDir = pathsOf(deps).stateDir;

  if (swept.length > 0) {
    steps.done("Cleaned up after ended pi sessions");
  }

  const outcome = await steps.task(
    {
      pending: "Stopping the sandbox VM",
      done: (stopped) => (stopped === "stopped" ? "Stopped the sandbox VM" : undefined),
    },
    () => backend.vm.stop({ busy: () => vmSessions(backend, stateDir) }),
  );

  if (outcome === "stopped") {
    steps.close("The next pi starts it again.");

    return 0;
  }

  steps.close(NOTHING_TO_STOP[outcome]);

  return 0;
};
