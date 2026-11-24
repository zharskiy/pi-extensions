import { rm } from "node:fs/promises";
import { removeBuildLeftovers } from "../../image/index.ts";
import { errorMessage, knownRepos, LauncherError, stateLayout } from "../../shared/index.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { refuseBusy } from "../pinata/host.ts";
import { removeSandbox } from "../pinata/uninstall.ts";
import type { Timers } from "../prompt/types.ts";
import { stepsFrontEnd } from "../setup/apply.ts";
import type { ApplyEvent, HostFacts } from "../setup/types.ts";
import { type Steps, stepsOf } from "../steps.ts";
import { acceptAll } from "./init.ts";

const forgetVm = (stateDir: string) => async () => {
  const layout = stateLayout(stateDir);
  const legacy = (await knownRepos(stateDir)).map((hash) => layout.repo(hash).legacy.sync);
  const records = [layout.render, layout.renders, layout.sync.directory, layout.imageRecord, ...legacy];

  await Promise.all(records.map((path) => rm(path, { recursive: true, force: true })));

  await removeBuildLeftovers(stateDir);
};

const vmGone = (reason?: string) =>
  new LauncherError(
    `the sandbox VM is deleted and could not be created again${reason === undefined ? "" : `: ${reason}`}`,
    "fix that, then run pinata restart, which creates it",
  );

const frontOf = (steps: Steps) => (facts: HostFacts, timers: Timers) => {
  const front = stepsFrontEnd(steps, facts, timers);

  return {
    ...front,
    report: (event: ApplyEvent) => (event.kind === "vm-not-ready" ? undefined : front.report(event)),
  };
};

const createVm = async (deps: CliDeps, steps: Steps) => {
  const code = await acceptAll(deps, frontOf(steps)).catch((error: unknown) => {
    throw vmGone(errorMessage(error));
  });

  if (code !== 0) {
    throw vmGone();
  }
};

export const restartCommand = async (deps: CliDeps) => {
  const steps = stepsOf(deps);

  await refuseBusy(deps);

  await removeSandbox(deps, steps, forgetVm(pathsOf(deps).stateDir));

  await createVm(deps, steps);

  steps.close("The next pi rebuilds the image and reinstalls your extensions.");

  return 0;
};
