import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LauncherError, sha256Hex } from "../../shared/index.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { resolveJobPi } from "../host-pi.ts";
import {
  CONFIG_OUTCOMES,
  type ConfigOutcome,
  INSTALL_MODES,
  PACKAGE_NAME,
  ROOTS_CONFIG_SOURCE,
  readReceipt,
  SMOKE_RESULTS,
  writeReceipt,
} from "../install-receipt.ts";
import { launcherVersion } from "../versions.ts";

export const RECEIPT = "__receipt";

const SHA256 = /^[0-9a-f]{64}$/;

const POSITIVE = /^[1-9][0-9]*$/;

const flagValue = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];

  return value === undefined || value === "" || value === "-" ? undefined : value;
};

const oneOf = <T extends string>(values: readonly T[], value: string | undefined, flag: string): T => {
  const found = values.find((candidate) => candidate === value);

  if (found === undefined) {
    throw new LauncherError(`${RECEIPT}: ${flag} must be one of ${values.join(", ")}`);
  }

  return found;
};

const bootstrapOf = (env: NodeJS.ProcessEnv) => {
  const api = env.PI_INSTALL_BOOTSTRAP_API ?? "";
  const version = env.PI_INSTALL_BOOTSTRAP_VERSION;

  return POSITIVE.test(api)
    ? { api: Number.parseInt(api, 10), version: version === undefined || version === "" ? null : version }
    : null;
};

const writtenSha = async (deps: CliDeps) => {
  const text = await readFile(pathsOf(deps).userConfigFile, "utf8").catch(() => undefined);

  return text === undefined ? null : sha256Hex(text);
};

const configOf = async (deps: CliDeps, args: string[]) => {
  const from = flagValue(args, "--config-from");

  if (from === undefined) {
    return undefined;
  }

  const outcome: ConfigOutcome = oneOf(
    CONFIG_OUTCOMES,
    flagValue(args, "--config-outcome"),
    "--config-outcome",
  );
  const sha256 = flagValue(args, "--config-sha256");

  if (from === ROOTS_CONFIG_SOURCE) {
    return { from, sha256: await writtenSha(deps), outcome };
  }

  return {
    from: resolve(deps.cwd, from),
    sha256: sha256 !== undefined && SHA256.test(sha256) ? sha256 : null,
    outcome,
  };
};

export const receiptCommand = async (deps: CliDeps, args: string[]) => {
  const { stateDir } = pathsOf(deps);
  const previous = await readReceipt(stateDir);
  const source = flagValue(args, "--extensions");
  const pi = await resolveJobPi(deps);

  await writeReceipt(stateDir, {
    installedAt: new Date(deps.now()).toISOString(),
    package: {
      name: PACKAGE_NAME,
      version: await launcherVersion(),
      spec: flagValue(args, "--spec") ?? null,
      mode: oneOf(INSTALL_MODES, flagValue(args, "--mode"), "--mode"),
    },
    bootstrap: bootstrapOf(deps.env),
    pi: { version: pi?.version ?? null },
    extensions: source === undefined ? (previous?.extensions ?? null) : { source },
    config: (await configOf(deps, args)) ?? previous?.config ?? null,
    smoke: oneOf(SMOKE_RESULTS, flagValue(args, "--smoke"), "--smoke"),
  });

  return 0;
};
