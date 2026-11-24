import { mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { locateManagedPi } from "../../hostpi/index.ts";
import { LauncherError, lstatOrUndefined, realOrResolved } from "../../shared/index.ts";
import { type CliDeps, hostAgentDirOf, pathsOf } from "../deps.ts";
import { say } from "./host.ts";

const shimPath = async (deps: CliDeps) => join(await realOrResolved(join(deps.home, ".local", "bin")), "pi");

const recordOf = (deps: CliDeps) => join(pathsOf(deps).stateDir, "replaced-pi-link");

const isOurs = async (path: string) => {
  const target = await readlink(path).catch(() => undefined);

  return target === undefined
    ? (await readFile(path, "utf8").catch(() => "")).includes("launcher/bin/pi-sandbox")
    : /\/pi-sandbox(-dev)?(\.js)?$/.test(target);
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
      `${path} is neither the pi-sandbox launcher nor pi's managed install in ${hostAgentDirOf(deps)}`,
      "move it away and run this again",
    );
  }

  return { path, managed };
};

export const installShim = async (
  deps: CliDeps,
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

  say(deps, `launcher: linked ${shim.path} to ${target}`);
};

export const removeShim = async (deps: CliDeps) => {
  const path = await shimPath(deps);
  const recorded = (await readFile(recordOf(deps), "utf8").catch(() => "")).trim();

  if (await isOurs(path)) {
    await rm(path);

    say(deps, `launcher: removed ${path}`);
  }

  if (recorded === "" || (await readlink(path).catch(() => "")) === recorded) {
    return;
  }

  if ((await lstatOrUndefined(path)) !== undefined) {
    return say(
      deps,
      `launcher: put pi's managed link back with ln -s '${recorded}' '${path}' once that path is free`,
    );
  }

  await symlink(recorded, path);

  say(deps, `launcher: restored ${path} to ${recorded}`);
};
