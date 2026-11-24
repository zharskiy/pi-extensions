import { join, resolve } from "node:path";
import { validateConfigFile } from "../../config/index.ts";
import { locateManagedPi } from "../../hostpi/index.ts";
import {
  jsonText,
  LauncherError,
  readJsonFile,
  readJsonObject,
  writeFileAtomic,
} from "../../shared/index.ts";
import { initCommand, YES_FLAG } from "../commands/init.ts";
import { type CliDeps, hostAgentDirOf, isTerminal, pathsOf } from "../deps.ts";
import { resolveJobPi } from "../host-pi.ts";
import { intercept } from "../intercept.ts";
import { isSet } from "../prompt/terminal.ts";
import { launcherVersion, PI_PACKAGE, testedPiVersion } from "../versions.ts";
import { interactive, isCheckout, PACKAGE, piSources, preflight, refuseBusy, say } from "./host.ts";
import { setPathBlock } from "./path-block.ts";
import { inspectPinataLink, inspectShim, installPinataLink, installShim, removePinataLink } from "./shim.ts";

export interface InstallFlags {
  pi?: string;
  config?: string;
  yes?: boolean;
}

export const refusePinnedManaged = async (deps: CliDeps, pi: string | undefined) => {
  if (pi !== undefined && (await locateManagedPi(hostAgentDirOf(deps))) !== undefined) {
    throw new LauncherError(
      `--pi ${pi}: pi's managed install in ${hostAgentDirOf(deps)} is the host pi and wins over npm's, so the version would be ignored`,
      "drop --pi, or remove the managed install with curl -fsSL https://pi.dev/install.sh | sh (Uninstall Pi) and run this again",
    );
  }
};

const readConfig = async (deps: CliDeps, given: string) => {
  const file = resolve(deps.cwd, given);
  const value = await readJsonFile<unknown>(file);

  if (value === undefined) {
    throw new LauncherError(`--config ${file}: no such file`);
  }

  validateConfigFile(value, file);

  return { file, value };
};

const ensurePi = async (deps: CliDeps, pi: string | undefined) => {
  if (pi === undefined && (await resolveJobPi(deps)) !== undefined) {
    return;
  }

  const version = pi ?? (await testedPiVersion());

  say(deps, `pi: installing ${PI_PACKAGE}@${version} with npm`);

  await interactive(deps, "npm", ["install", "-g", "--ignore-scripts", `${PI_PACKAGE}@${version}`]);
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
  await refusePinnedManaged(deps, flags.pi);

  const config = flags.config === undefined ? undefined : await readConfig(deps, flags.config);
  const checkout = await isCheckout(deps, packageDir);

  await preflight(deps);

  await refuseBusy(deps);

  await inspectShim(deps);

  if (checkout) {
    await inspectPinataLink(deps);
  }

  await ensurePi(deps, flags.pi);

  const shim = await inspectShim(deps);

  await ensureExtensions(deps, checkout ? packageDir : `npm:${PACKAGE}@${await launcherVersion()}`);

  await installShim(
    deps,
    shim,
    join(packageDir, "launcher", "bin", checkout ? "pi-sandbox-dev.js" : "pi-sandbox.js"),
  );

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
