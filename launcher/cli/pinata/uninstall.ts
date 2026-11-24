import { rm, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ENGINE_PROFILE } from "../../backend/index.ts";
import { LauncherError, lstatOrUndefined, realOrResolved, stateLayout } from "../../shared/index.ts";
import { releaseSandbox } from "../commands/uninstall.ts";
import { type CliDeps, hostAgentDirOf, pathsOf } from "../deps.ts";
import { resolveJobPi } from "../host-pi.ts";
import { runQuietly, type Steps, stepsOf, tilde } from "../steps.ts";
import { hostPiQuietly, PACKAGE, piSources, refuseBusy } from "./host.ts";
import { setPathBlock } from "./path-block.ts";
import { removePinataLink, removeShim } from "./shim.ts";

const SANDBOX = {
  pending: "Removing the sandbox VM and its data",
  failed: "Could not remove the sandbox VM",
};

const deleteVm = async (deps: CliDeps) => {
  const env = { COLIMA_HOME: join(deps.home, ".colima") };

  await runQuietly(deps, ["colima", "delete", "--profile", ENGINE_PROFILE, "--force", "--data"], { env });
};

export const removeSandbox = async (
  deps: CliDeps,
  steps: Steps,
  forget: () => Promise<void> = async () => undefined,
) => {
  const present = (await deps.backend().vm.inspect()).state !== "absent";
  const stateKept = (await lstatOrUndefined(pathsOf(deps).stateDir)) !== undefined;

  const teardown = () => (present ? deleteVm(deps) : Promise.resolve());

  const released = () =>
    releaseSandbox(deps, steps.note, async () => {
      await teardown();

      await forget();
    });

  await steps.task({ ...SANDBOX, done: present ? "Removed the sandbox VM and its data" : undefined }, () =>
    stateKept ? released() : teardown(),
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

  if ((await resolveJobPi(deps)) === undefined) {
    const settings = tilde(deps, join(hostAgentDirOf(deps), "settings.json"));

    steps.warn(`pi is not installed, so pinata's extensions stay listed in pi's settings (${settings})`);

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

  await removeShim(deps, steps);

  if (sandboxOnly) {
    await removeState(deps, steps);

    steps.close("The sandbox is uninstalled.", [["Bring back", "pinata install"]]);

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
