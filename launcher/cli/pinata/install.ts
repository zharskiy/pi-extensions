import { join, resolve } from "node:path";
import { validateConfigFile } from "../../config/index.ts";
import {
  jsonText,
  LauncherError,
  readJsonFile,
  readJsonObject,
  writeFileAtomic,
} from "../../shared/index.ts";
import { initCommand, YES_FLAG } from "../commands/init.ts";
import { type CliDeps, isTerminal, pathsOf } from "../deps.ts";
import { intercept } from "../intercept.ts";
import { isSet } from "../prompt/terminal.ts";
import { launcherVersion } from "../versions.ts";
import { isCheckout, PACKAGE, piSources, preflight, refuseBusy, requireHostPi, say } from "./host.ts";
import { setPathBlock } from "./path-block.ts";
import { inspectPinataLink, inspectShim, installPinataLink, installShim, removePinataLink } from "./shim.ts";

export interface InstallFlags {
  config?: string;
  yes?: boolean;
}

const readConfig = async (deps: CliDeps, given: string) => {
  const file = resolve(deps.cwd, given);
  const value = await readJsonFile<unknown>(file);

  if (value === undefined) {
    throw new LauncherError(`--config ${file}: no such file`);
  }

  validateConfigFile(value, file);

  return { file, value };
};

const ensureExtensions = async (deps: CliDeps, own: string) => {
  if ((await piSources(deps)).includes(own)) {
    return;
  }

  const code = await intercept(["install", own], deps);

  if (code !== 0) {
    throw new LauncherError(`pi install ${own} exited with code ${code}`);
  }
};

const setup = async (deps: CliDeps, flags: InstallFlags) => {
  const configured = (await readJsonObject(pathsOf(deps).userConfigFile))?.workspaceRoot !== undefined;

  if (configured && flags.config === undefined && (await deps.backend().vm.inspect()).state !== "absent") {
    return 0;
  }

  const ask =
    isTerminal(deps.terminal.stdin) && !flags.yes && flags.config === undefined && !isSet(deps.env.CI);

  return initCommand(deps, ask && !configured ? [] : [YES_FLAG]);
};

const linkPinata = (deps: CliDeps, packageDir: string, checkout: boolean) =>
  checkout
    ? installPinataLink(deps, join(packageDir, "launcher", "bin", "pinata-dev.js"))
    : removePinataLink(deps);

export const install = async (deps: CliDeps, packageDir: string, flags: InstallFlags) => {
  await requireHostPi(deps, "install");

  const config = flags.config === undefined ? undefined : await readConfig(deps, flags.config);
  const checkout = await isCheckout(deps, packageDir);

  await preflight(deps);

  await refuseBusy(deps);

  const shim = await inspectShim(deps);

  if (checkout) {
    await inspectPinataLink(deps);
  }

  await ensureExtensions(deps, checkout ? packageDir : `npm:${PACKAGE}@${await launcherVersion()}`);

  await installShim(deps, shim, join(packageDir, "launcher", "bin", checkout ? "pi-dev.js" : "pi.js"));

  await linkPinata(deps, packageDir, checkout);

  await setPathBlock(deps, true);

  if (config !== undefined) {
    await writeFileAtomic(pathsOf(deps).userConfigFile, jsonText(config.value));

    say(deps, `config: wrote ${pathsOf(deps).userConfigFile} from ${config.file}`);
  }

  const code = await setup(deps, flags);

  say(deps, "next: open a new shell, cd into a repository in your workspace root and run pi");

  return code;
};
