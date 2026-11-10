import { type HostPi, isInsideRoots, locateManagedPi } from "../hostpi/index.ts";
import { LauncherError, realOrResolved } from "../shared/index.ts";
import { findGitRoot } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "./deps.ts";
import { sweepForHostPi } from "./host-sessions.ts";

export const NO_SANDBOX = "--no-sandbox";

const bundledOutside = async (deps: CliDeps, roots: string[]): Promise<HostPi | undefined> => {
  const bundled = await deps.bundledPi();

  if (bundled === undefined) {
    return undefined;
  }

  return (await isInsideRoots(bundled.packageDir, roots)) ? undefined : { ...bundled, source: "bundled" };
};

export const sandboxRoots = (_deps: CliDeps, context: LaunchContext) => [
  context.workspace.repoRoot,
  ...(context.workspace.gitCommonDir === undefined ? [] : [context.workspace.gitCommonDir]),
];

export const nearbyRoots = async (deps: CliDeps) => {
  const repoRoot = await findGitRoot(await realOrResolved(deps.cwd));

  return repoRoot === undefined ? [deps.cwd] : [deps.cwd, repoRoot];
};

export const resolveJobPi = async (deps: CliDeps, roots: string[]): Promise<HostPi | undefined> =>
  (await locateManagedPi(hostAgentDirOf(deps))) ?? bundledOutside(deps, roots);

export const interactiveCommand = (pi: HostPi) => (pi.wrapper === undefined ? pi.command : [pi.wrapper]);

export const hostPiPlace = (pi: HostPi) =>
  pi.source === "managed" ? `managed install ${pi.wrapper ?? ""}` : "next to the launcher";

export const hostPiText = (pi: HostPi) =>
  `pi ${pi.version}${pi.source === "managed" ? "," : ""} ${hostPiPlace(pi)}`;

export const runHostPi = async (deps: CliDeps, context: LaunchContext, piArgs: string[]) => {
  const { config, sources } = context.effective;

  if (config.fallback === "refuse") {
    throw new LauncherError(
      `${NO_SANDBOX} is refused: fallback is "refuse", set by ${sources.fallback ?? "default"}`,
      "run pi without --no-sandbox",
    );
  }

  const pi = await resolveJobPi(deps, sandboxRoots(deps, context));
  const command = pi === undefined ? [] : interactiveCommand(pi);
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
