import { join } from "node:path";
import { readJsonObject } from "../../shared/index.ts";
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
  yes?: boolean;
}

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

  if (configured && (await deps.backend().vm.inspect()).state !== "absent") {
    return { code: 0, asked: false };
  }

  const ask = isTerminal(deps.terminal.stdin) && !flags.yes && !isSet(deps.env.CI);

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

const close = (deps: CliDeps, steps: Steps, asked: boolean) => {
  if (!steps.changed() && !asked) {
    return steps.close("Pinata is already installed. Nothing changed.");
  }

  steps.close("Pinata is installed.", [
    ["Start", "open a new terminal, then cd <your repo> && pi"],
    ["Settings", tilde(deps, pathsOf(deps).userConfigFile)],
    ["Check", "pinata doctor"],
  ]);
};

export const install = async (deps: CliDeps, packageDir: string, flags: InstallFlags) => {
  await requireJobPi(deps, "install");

  const checkout = await isCheckout(deps, packageDir);
  const steps = stepsOf(deps);

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

  const { code, asked } = await setup(deps, steps, flags);

  if (code === 0) {
    close(deps, steps, asked);
  }

  return code;
};
