import { join, resolve } from "node:path";
import { validateConfigFile } from "../../config/index.ts";
import {
  jsonText,
  LauncherError,
  readJsonFile,
  readJsonObject,
  writeFileAtomic,
} from "../../shared/index.ts";
import { acceptAll, initCommand } from "../commands/init.ts";
import { type CliDeps, isTerminal, pathsOf } from "../deps.ts";
import { requireJobPi } from "../host-pi.ts";
import { isSet } from "../prompt/terminal.ts";
import { stepsFrontEnd } from "../setup/apply.ts";
import { type Steps, stepsOf, tilde } from "../steps.ts";
import { launcherVersion } from "../versions.ts";
import { hostPiQuietly, isCheckout, PACKAGE, piSources, preflight, refuseBusy } from "./host.ts";
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

const EXTENSIONS = {
  pending: "Registering pinata's extensions with pi",
  done: "Registered pinata's extensions with pi",
  failed: "Could not register pinata's extensions with pi",
};

const ensureExtensions = async (deps: CliDeps, steps: Steps, own: string) => {
  if ((await piSources(deps)).includes(own)) {
    return;
  }

  await steps.task(EXTENSIONS, () => hostPiQuietly(deps, ["install", own]));
};

const setup = async (deps: CliDeps, steps: Steps, flags: InstallFlags) => {
  const configured = (await readJsonObject(pathsOf(deps).userConfigFile))?.workspaceRoot !== undefined;

  if (configured && flags.config === undefined && (await deps.backend().vm.inspect()).state !== "absent") {
    return { code: 0, asked: false };
  }

  const ask =
    isTerminal(deps.terminal.stdin) && !flags.yes && flags.config === undefined && !isSet(deps.env.CI);

  if (ask && !configured) {
    return { code: await initCommand(deps, []), asked: true };
  }

  return {
    code: await acceptAll(deps, (facts, timers) => stepsFrontEnd(steps, facts, timers)),
    asked: false,
  };
};

const linkPinata = (deps: CliDeps, steps: Steps, packageDir: string, checkout: boolean) =>
  checkout
    ? installPinataLink(deps, steps, join(packageDir, "launcher", "bin", "pinata-dev.js"))
    : removePinataLink(deps, steps);

export const UPDATED_FROM = "PINATA_UPDATED_FROM";

const close = async (deps: CliDeps, steps: Steps, asked: boolean) => {
  if (deps.env[UPDATED_FROM] !== undefined) {
    return steps.close(`Pinata is up to date (${await launcherVersion()}).`);
  }

  if (!steps.changed() && !asked) {
    return steps.close("Pinata is already installed. Nothing changed.");
  }

  steps.close("Pinata is installed.", [
    ["Start", "open a new terminal, then cd <your repo> && pi"],
    ["Settings", tilde(deps, pathsOf(deps).userConfigFile)],
    ["Check", "pinata doctor"],
  ]);
};

const announceUpdate = async (deps: CliDeps, steps: Steps) => {
  const from = deps.env[UPDATED_FROM];
  const version = await launcherVersion();

  if (from !== undefined && from !== version) {
    steps.done(`Updated pinata ${from} → ${version}`);
  }
};

export const install = async (deps: CliDeps, packageDir: string, flags: InstallFlags) => {
  await requireJobPi(deps, "install");

  const config = flags.config === undefined ? undefined : await readConfig(deps, flags.config);
  const checkout = await isCheckout(deps, packageDir);
  const steps = stepsOf(deps);

  await announceUpdate(deps, steps);

  await preflight(deps, steps);

  await refuseBusy(deps);

  const shim = await inspectShim(deps);

  if (checkout) {
    await inspectPinataLink(deps);
  }

  await ensureExtensions(deps, steps, checkout ? packageDir : `npm:${PACKAGE}@${await launcherVersion()}`);

  await installShim(deps, steps, shim, join(packageDir, "launcher", "bin", checkout ? "pi-dev.js" : "pi.js"));

  await linkPinata(deps, steps, packageDir, checkout);

  await setPathBlock(deps, steps, true);

  if (config !== undefined) {
    await writeFileAtomic(pathsOf(deps).userConfigFile, jsonText(config.value));

    steps.done(
      `Copied the settings from ${tilde(deps, config.file)} (${tilde(deps, pathsOf(deps).userConfigFile)})`,
    );
  }

  const { code, asked } = await setup(deps, steps, flags);

  if (code === 0) {
    await close(deps, steps, asked);
  }

  return code;
};
