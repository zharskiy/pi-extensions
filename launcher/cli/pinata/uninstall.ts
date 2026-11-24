import { rm, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ENGINE_PROFILE } from "../../backend/index.ts";
import {
  errorMessage,
  LauncherError,
  lstatOrUndefined,
  realOrResolved,
  stateLayout,
} from "../../shared/index.ts";
import { releaseSandbox } from "../commands/uninstall.ts";
import { type CliDeps, hostAgentDirOf, pathsOf } from "../deps.ts";
import { runQuietly, type Steps, stepsOf, tilde } from "../steps.ts";
import { hostPiQuietly, PACKAGE, piSources, refuseBusy } from "./host.ts";
import { setPathBlock } from "./path-block.ts";
import { removePinataLink, removeShim } from "./shim.ts";

const release = async (deps: CliDeps, steps: Steps) => {
  if ((await lstatOrUndefined(pathsOf(deps).stateDir)) === undefined) {
    return;
  }

  await releaseSandbox(deps, steps.note).catch((error: unknown) => {
    throw error instanceof LauncherError && error.hint !== undefined
      ? error
      : new LauncherError(
          errorMessage(error),
          `colima delete --profile ${ENGINE_PROFILE} --force --data removes the VM with everything in it, then run pinata uninstall again`,
        );
  });
};

const SANDBOX = {
  pending: "Removing the sandbox VM and its data",
  failed: "Could not remove the sandbox VM",
};

const removeSandbox = async (deps: CliDeps, steps: Steps) => {
  const present = (await deps.backend().vm.inspect()).state !== "absent";
  const env = { COLIMA_HOME: join(deps.home, ".colima") };

  await steps.task(
    { ...SANDBOX, done: present ? "Removed the sandbox VM and its data" : undefined },
    async () => {
      await release(deps, steps);

      if (present) {
        await runQuietly(deps, ["colima", "delete", "--profile", ENGINE_PROFILE, "--force", "--data"], {
          env,
        });
      }
    },
  );
};

const EXTENSIONS = {
  pending: "Removing pinata's extensions from pi",
  done: "Removed pinata's extensions from pi",
  failed: "Could not remove pinata's extensions from pi",
};

const removeExtensions = async (deps: CliDeps, steps: Steps, packageDir: string) => {
  const own = (await piSources(deps)).filter(
    (source) => source === packageDir || source === `npm:${PACKAGE}` || source.startsWith(`npm:${PACKAGE}@`),
  );

  if (own.length === 0) {
    return;
  }

  await steps.task(EXTENSIONS, () =>
    own.reduce(
      (previous, source) => previous.then(() => hostPiQuietly(deps, ["remove", source])),
      Promise.resolve(),
    ),
  );
};

const COMMAND = {
  pending: "Removing the pinata command",
  done: "Removed the pinata command",
  failed: "Could not remove the pinata command",
};

const closeSandboxOnly = (deps: CliDeps, steps: Steps, hostPi: boolean) =>
  steps.close(
    hostPi
      ? "The sandbox is uninstalled and pi runs on the host again. Kept on purpose:"
      : "The sandbox is uninstalled. Kept on purpose:",
    [
      ["Extensions", "pinata's extensions stay loaded in pi"],
      ["Settings", tilde(deps, pathsOf(deps).userConfigFile)],
      ["Bring back", "pinata install"],
    ],
  );

const removeState = async (deps: CliDeps, steps: Steps) => {
  const { stateDir, userConfigFile } = pathsOf(deps);
  const info = await lstatOrUndefined(stateDir);
  const launcherDir = join(hostAgentDirOf(deps), "pinata");

  if (info === undefined) {
    return;
  }

  const real = await realOrResolved(stateDir);
  const guarded = await Promise.all([deps.home, hostAgentDirOf(deps), userConfigFile].map(realOrResolved));
  const holds = guarded.some((path) => !relative(real, path).startsWith(".."));
  const marked =
    stateDir === join(launcherDir, "state") ||
    (await lstatOrUndefined(stateLayout(stateDir).salt)) !== undefined;

  if (holds || info.isSymbolicLink() || !marked) {
    throw new LauncherError(
      `${stateDir} does not look like pinata's state, left as it is`,
      "remove it by hand",
    );
  }

  await rm(stateDir, { recursive: true });

  await rmdir(launcherDir).catch(() => undefined);

  steps.done("Removed pinata's state");
};

export const uninstall = async (deps: CliDeps, packageDir: string, sandboxOnly: boolean) => {
  const steps = stepsOf(deps);

  await refuseBusy(deps);

  await removeSandbox(deps, steps);

  const hostPi = await removeShim(deps, steps);

  if (sandboxOnly) {
    await removeState(deps, steps);

    closeSandboxOnly(deps, steps, hostPi);

    return 0;
  }

  await removePinataLink(deps, steps);

  await removeExtensions(deps, steps, packageDir);

  await setPathBlock(deps, steps, false);

  await removeState(deps, steps);

  if ((await lstatOrUndefined(join(packageDir, ".git"))) === undefined) {
    await steps.task(COMMAND, () => runQuietly(deps, ["npm", "uninstall", "-g", PACKAGE]));
  }

  steps.close("Pinata is uninstalled. Kept on purpose:", [
    ["Settings", tilde(deps, pathsOf(deps).userConfigFile)],
    ["pi sessions", tilde(deps, join(hostAgentDirOf(deps), "sessions"))],
    ["pi, colima", "remove them yourself if you no longer need them"],
  ]);

  return 0;
};
