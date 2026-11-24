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
import { type CliDeps, hostAgentDirOf, pathsOf, writeLines } from "../deps.ts";
import { intercept } from "../intercept.ts";
import { PI_PACKAGE } from "../versions.ts";
import { interactive, PACKAGE, piSources, refuseBusy, say } from "./host.ts";
import { setPathBlock } from "./path-block.ts";
import { removePinataLink, removeShim } from "./shim.ts";

const release = async (deps: CliDeps) => {
  if ((await lstatOrUndefined(pathsOf(deps).stateDir)) === undefined) {
    return;
  }

  await releaseSandbox(deps).catch((error: unknown) => {
    throw error instanceof LauncherError && error.hint !== undefined
      ? error
      : new LauncherError(
          errorMessage(error),
          `colima delete --profile ${ENGINE_PROFILE} --force --data removes the VM with everything in it, then run pinata uninstall again`,
        );
  });
};

const deleteVm = async (deps: CliDeps) => {
  if ((await deps.backend().vm.inspect()).state === "absent") {
    return;
  }

  await interactive(deps, "colima", ["delete", "--profile", ENGINE_PROFILE, "--force", "--data"], {
    COLIMA_HOME: join(deps.home, ".colima"),
  });

  say(deps, `colima: deleted the ${ENGINE_PROFILE} VM with its containers, volumes and images`);
};

const removeExtensions = async (deps: CliDeps, packageDir: string) => {
  const own = (await piSources(deps)).filter(
    (source) => source === packageDir || source === `npm:${PACKAGE}` || source.startsWith(`npm:${PACKAGE}@`),
  );

  await own.reduce(async (previous, source) => {
    await previous;

    if ((await intercept(["remove", source], deps)) !== 0) {
      throw new LauncherError(`pi remove ${source} failed`);
    }

    say(deps, `pi: removed ${source}`);
  }, Promise.resolve());
};

const removeState = async (deps: CliDeps) => {
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

  say(deps, `state: removed ${stateDir}`);
};

export const uninstall = async (deps: CliDeps, packageDir: string) => {
  await refuseBusy(deps);

  await release(deps);

  await deleteVm(deps);

  await removeShim(deps);

  await removePinataLink(deps);

  await removeExtensions(deps, packageDir);

  await setPathBlock(deps, false);

  await removeState(deps);

  writeLines(deps.stdout, [
    `kept: ${pathsOf(deps).userConfigFile}, pi's sessions in ${join(hostAgentDirOf(deps), "sessions")}, pi and colima`,
    `kept: remove pi with npm uninstall -g ${PI_PACKAGE} (a managed pi with pi's installer), colima with brew uninstall colima`,
  ]);

  if ((await lstatOrUndefined(join(packageDir, ".git"))) === undefined) {
    await interactive(deps, "npm", ["uninstall", "-g", PACKAGE]);
  }

  return 0;
};
