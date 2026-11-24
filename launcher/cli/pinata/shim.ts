import { mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { locateManagedPi } from "../../hostpi/index.ts";
import { LauncherError, lstatOrUndefined, realOrResolved } from "../../shared/index.ts";
import { type CliDeps, hostAgentDirOf, pathsOf } from "../deps.ts";
import { type Steps, tilde } from "../steps.ts";

const linkPath = async (deps: CliDeps, name: string) =>
  join(await realOrResolved(join(deps.home, ".local", "bin")), name);

const shimPath = (deps: CliDeps) => linkPath(deps, "pi");

const recordOf = (deps: CliDeps) => join(pathsOf(deps).stateDir, "replaced-pi-link");

const PI_ENTRY_LINK = /\/launcher\/bin\/pi(-dev)?\.js$/;

const PINATA_ENTRY_LINK = /\/launcher\/bin\/pinata-dev\.js$/;

const isOurs = async (path: string) => {
  const target = await readlink(path).catch(() => undefined);

  return target !== undefined && PI_ENTRY_LINK.test(target);
};

const isPinataLink = async (path: string) => {
  const target = await readlink(path).catch(() => undefined);

  return target !== undefined && PINATA_ENTRY_LINK.test(target);
};

const isManaged = async (deps: CliDeps, path: string) =>
  (await realpath(path).catch(() => "")) ===
    (await realOrResolved(join(hostAgentDirOf(deps), "bin", "pi"))) &&
  (await locateManagedPi(hostAgentDirOf(deps))) !== undefined;

export const inspectShim = async (deps: CliDeps) => {
  const path = await shimPath(deps);
  const found = (await lstatOrUndefined(path)) !== undefined;
  const ours = found && (await isOurs(path));
  const managed = found && !ours && (await isManaged(deps, path));

  if (found && !ours && !managed) {
    throw new LauncherError(
      `${path} is neither pinata's link nor pi's managed install in ${hostAgentDirOf(deps)}`,
      "move it away and run this again",
    );
  }

  return { path, managed };
};

export const installShim = async (
  deps: CliDeps,
  steps: Steps,
  shim: { path: string; managed: boolean },
  target: string,
) => {
  if ((await readlink(shim.path).catch(() => "")) === target) {
    return;
  }

  if (shim.managed) {
    await mkdir(pathsOf(deps).stateDir, { recursive: true });

    await writeFile(recordOf(deps), await readlink(shim.path));
  }

  await rm(shim.path, { force: true });

  await mkdir(dirname(shim.path), { recursive: true });

  await symlink(target, shim.path);

  steps.done(`Linked pi to the sandbox (${tilde(deps, shim.path)})`);
};

export const removeShim = async (deps: CliDeps, steps: Steps) => {
  const path = await shimPath(deps);
  const recorded = (await readFile(recordOf(deps), "utf8").catch(() => "")).trim();
  const ours = await isOurs(path);

  if (ours) {
    await rm(path);
  }

  if (recorded === "" || (await readlink(path).catch(() => "")) === recorded) {
    if (ours) {
      steps.done(`Removed pinata's pi link (${tilde(deps, path)})`);
    }

    return;
  }

  if ((await lstatOrUndefined(path)) !== undefined) {
    steps.warn(
      `Could not put pi's own link back, since ${tilde(deps, path)} is taken; once it is free, run ln -s '${recorded}' '${path}'`,
    );

    return;
  }

  await symlink(recorded, path);

  steps.done(`Restored pi's own link (${tilde(deps, path)})`);
};

export const inspectPinataLink = async (deps: CliDeps) => {
  const path = await linkPath(deps, "pinata");

  if ((await lstatOrUndefined(path)) !== undefined && !(await isPinataLink(path))) {
    throw new LauncherError(`${path} is not pinata's link`, "move it away and run this again");
  }

  return path;
};

export const installPinataLink = async (deps: CliDeps, steps: Steps, target: string) => {
  const path = await inspectPinataLink(deps);

  if ((await readlink(path).catch(() => "")) === target) {
    return;
  }

  await rm(path, { force: true });

  await mkdir(dirname(path), { recursive: true });

  await symlink(target, path);

  steps.done(`Linked pinata to this checkout (${tilde(deps, path)})`);
};

export const removePinataLink = async (deps: CliDeps, steps: Steps) => {
  const path = await linkPath(deps, "pinata");

  if (await isPinataLink(path)) {
    await rm(path);

    steps.done(`Removed the pinata command (${tilde(deps, path)})`);
  }
};
