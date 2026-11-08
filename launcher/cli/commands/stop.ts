import { liveSessions } from "../../grants/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import {
  instanceOf,
  OWN_PROFILE,
  ownProfileExists,
  runColima,
  vmRunning,
  withVmLock,
} from "../vm-lifecycle.ts";

const STOP_FAILURE = "could not stop the sandbox VM";

const sessionsRunning = (count: number) =>
  count === 1 ? "1 pi session is running" : `${count} pi sessions are running`;

const assertNoSession = async (stateDir: string) => {
  const live = await liveSessions(stateDir);

  if (live.length > 0) {
    throw new LauncherError(
      `${sessionsRunning(live.length)}; stopping the sandbox VM would end them`,
      "exit them and run pi sandbox stop again",
    );
  }
};

const stopVm = async (deps: CliDeps, stateDir: string) => {
  await assertNoSession(stateDir);

  await runColima(
    deps,
    STOP_FAILURE,
    ["stop", "--profile", OWN_PROFILE],
    `see ~/.colima/_lima/${instanceOf(OWN_PROFILE)}/ha.stderr.log`,
  );
};

export const stopCommand = async (deps: CliDeps) => {
  const stateDir = pathsOf(deps).stateDir;

  if (!(await ownProfileExists(deps))) {
    writeLine(deps.stdout, `no sandbox VM: the colima profile ${OWN_PROFILE} does not exist`);

    return 0;
  }

  if (!(await vmRunning(deps, STOP_FAILURE))) {
    writeLine(deps.stdout, "the sandbox VM is already stopped");

    return 0;
  }

  await assertNoSession(stateDir);

  await withVmLock(stateDir, () => stopVm(deps, stateDir));

  const instances = await deps.proxy.list(stateDir);

  await deps.proxy.stop(stateDir);

  writeLines(deps.stdout, [
    ...instances.map((instance) => `stopped proxy pid ${instance.pid} port ${instance.port}`),
    `stopped the sandbox VM (profile ${OWN_PROFILE}); the next pi starts it again`,
  ]);

  return 0;
};
