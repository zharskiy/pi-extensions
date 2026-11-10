import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findOnPath, type HostPi, isInsideRoots, locateManagedPi, locatePiPackage } from "../hostpi/index.ts";
import { expandHome, isWithin, LauncherError, launcherRoot, realOrResolved } from "../shared/index.ts";
import { findGitRoot } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "./deps.ts";
import { sweepForHostPi } from "./host-sessions.ts";

export const NO_SANDBOX = "--no-sandbox";

const WRAPPER_LIMIT = 4096;

const WRAPPER_MARKER = "launcher/bin/pi-sandbox";

const isWrapper = async (path: string) => {
  const info = await stat(path);

  if (!info.isFile() || info.size > WRAPPER_LIMIT) {
    return false;
  }

  return (await readFile(path, "utf8")).includes(WRAPPER_MARKER);
};

const isLauncherFile = async (real: string, ownBinDir: string) =>
  isWithin(real, ownBinDir) || (await isWrapper(real).catch(() => true));

const pathPi = async (deps: CliDeps, roots: string[]) => {
  const ownBinDir = await realOrResolved(join(launcherRoot(), "bin"));

  return findOnPath(deps.env, "pi", roots, async (_path, real) => !(await isLauncherFile(real, ownBinDir)));
};

export interface ShellPi {
  command: string[];
  source: HostPi["source"];
  version?: string;
  wrapper?: string;
}

const bundledOutside = async (deps: CliDeps, roots: string[]): Promise<HostPi | undefined> => {
  const bundled = await deps.bundledPi();

  if (bundled === undefined) {
    return undefined;
  }

  return (await isInsideRoots(bundled.packageDir, roots)) ? undefined : { ...bundled, source: "bundled" };
};

export const sandboxRoots = (deps: CliDeps, context: LaunchContext) => [
  context.workspace.repoRoot,
  ...(context.workspace.gitCommonDir === undefined ? [] : [context.workspace.gitCommonDir]),
  ...context.effective.config.mounts.extraReadOnly.map((path) =>
    resolve(context.workspace.repoRoot, expandHome(path, deps.home)),
  ),
];

export const nearbyRoots = async (deps: CliDeps) => {
  const repoRoot = await findGitRoot(await realOrResolved(deps.cwd));

  return repoRoot === undefined ? [deps.cwd] : [deps.cwd, repoRoot];
};

export const resolveJobPi = async (deps: CliDeps, roots: string[]): Promise<HostPi | undefined> =>
  (await locateManagedPi(hostAgentDirOf(deps))) ?? bundledOutside(deps, roots);

export const resolveShellPi = async (deps: CliDeps, roots: string[]): Promise<ShellPi | undefined> => {
  const managed = await locateManagedPi(hostAgentDirOf(deps));

  if (managed !== undefined) {
    return managed;
  }

  const onPath = await pathPi(deps, roots);

  if (onPath === undefined) {
    return bundledOutside(deps, roots);
  }

  return (await locatePiPackage(onPath)) ?? { command: [onPath], source: "path" };
};

export const interactiveCommand = (pi: ShellPi) => (pi.wrapper === undefined ? pi.command : [pi.wrapper]);

const hostPiCommand = async (deps: CliDeps, roots: string[]) => {
  const pi = await resolveShellPi(deps, roots);

  return pi === undefined ? undefined : interactiveCommand(pi);
};

export const hostPiPlace = (pi: ShellPi) => {
  if (pi.source === "managed") {
    return `managed install ${pi.wrapper ?? ""}`;
  }

  return pi.source === "path" ? `at ${pi.command.at(-1) ?? ""}` : "next to the launcher";
};

export const hostPiText = (pi: ShellPi) =>
  `pi${pi.version === undefined ? "" : ` ${pi.version}`}${pi.source === "managed" ? "," : ""} ${hostPiPlace(pi)}`;

export const runHostPi = async (deps: CliDeps, context: LaunchContext, piArgs: string[]) => {
  const { config, sources } = context.effective;

  if (config.fallback === "refuse") {
    throw new LauncherError(
      `${NO_SANDBOX} is refused: fallback is "refuse", set by ${sources.fallback ?? "default"}`,
      "run pi without --no-sandbox",
    );
  }

  const command = (await hostPiCommand(deps, sandboxRoots(deps, context))) ?? [];
  const [file, ...prefix] = command;

  if (file === undefined) {
    throw new LauncherError(
      `${NO_SANDBOX}: no pi on the host`,
      "install pi on the host, or reinstall the launcher with npm install -g pi-extensions-mz",
    );
  }

  writeLine(deps.stderr, `pi-sandbox: warning: running ${command.at(-1)} on the host, outside the sandbox`);

  await sweepForHostPi(deps, context);

  return deps.runner.spawnInteractive(file, [...prefix, ...piArgs], { cwd: deps.cwd });
};
