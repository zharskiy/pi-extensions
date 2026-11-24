import { join, resolve } from "node:path";
import { busyText } from "../../backend/index.ts";
import {
  isJsonObject,
  LauncherError,
  lstatOrUndefined,
  readJsonObject,
  realOrResolved,
} from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, hostAgentDirOf, pathsOf } from "../deps.ts";
import { intercept } from "../intercept.ts";
import { ChildFailure, quietDeps, runQuietly, type Steps } from "../steps.ts";
import { isOlderVersion, launcherVersion } from "../versions.ts";

export const PACKAGE = "@zharskiy/pinata";

const output = async (deps: CliDeps, file: string, args: string[]) => {
  const result = await deps.runner.run(file, args, { cwd: deps.home }).catch(() => undefined);

  return result?.code === 0 ? result.stdout.trim() : undefined;
};

export const hostPiQuietly = async (deps: CliDeps, args: string[]) => {
  const quiet = quietDeps(deps);
  const code = await intercept(args, quiet.deps);

  if (code !== 0) {
    throw new ChildFailure(["pi", ...args], code ?? 1, quiet.output());
  }
};

const COLIMA = { pending: "Installing colima", done: "Installed colima", failed: "Could not install colima" };

export const preflight = async (deps: CliDeps, steps: Steps) => {
  if (process.getuid?.() === 0) {
    throw new LauncherError("run pinata as your own user, not as root or with sudo");
  }

  if (isOlderVersion(process.versions.node, "22.19.0")) {
    throw new LauncherError(`node ${process.versions.node} is too old, install Node 22.19.0 or newer`);
  }

  const found = await output(deps, "colima", ["version"]);
  const text =
    found ??
    (await steps
      .task(COLIMA, () => runQuietly(deps, ["brew", "install", "colima"]))
      .then(() => output(deps, "colima", ["version"])));
  const colima = /colima version v?([0-9.]+)/.exec(text ?? "")?.[1] ?? "unknown";

  if (colima === "unknown" || isOlderVersion(colima, "0.9.0")) {
    throw new LauncherError(`colima ${colima} is older than 0.9.0, run brew upgrade colima`);
  }
};

export const refuseBusy = async (deps: CliDeps) => {
  const sessions = await vmSessions(deps.backend(), pathsOf(deps).stateDir);

  if (sessions.count > 0) {
    throw new LauncherError(`${busyText(sessions)} in the sandbox VM`, "exit them, then run this again");
  }
};

export const isCheckout = async (deps: CliDeps, packageDir: string) => {
  if ((await lstatOrUndefined(join(packageDir, ".git"))) !== undefined) {
    return true;
  }

  const installed = join(
    (await output(deps, "npm", ["prefix", "-g"])) ?? "/",
    "lib",
    "node_modules",
    PACKAGE,
  );

  if ((await realOrResolved(installed)) !== (await realOrResolved(packageDir))) {
    throw new LauncherError(
      `${packageDir} is neither a checkout nor the global npm install of ${PACKAGE}`,
      `npm install -g --legacy-peer-deps ${PACKAGE}@${await launcherVersion()}`,
    );
  }

  return false;
};

export const piSources = async (deps: CliDeps) => {
  const agentDir = hostAgentDirOf(deps);
  const packages = (await readJsonObject(join(agentDir, "settings.json")))?.packages;

  return (Array.isArray(packages) ? packages : [])
    .map((entry) => (isJsonObject(entry) ? entry.source : entry))
    .filter((source): source is string => typeof source === "string")
    .map((source) => (/^[a-z+]+:/.test(source) ? source : resolve(agentDir, source)));
};
