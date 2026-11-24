import { loadEffectiveConfig } from "../config/index.ts";
import { type HostPi, locateManagedPi, locateNpmPi } from "../hostpi/index.ts";
import { isWithin, LauncherError } from "../shared/index.ts";
import { sandboxWriteRoots } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeLine } from "./deps.ts";
import { sweepForHostPi } from "./host-sessions.ts";

export const NO_SANDBOX = "--no-sandbox";

const outsideRoots = (roots: string[]) => async (path: string, real: string) =>
  !roots.some((root) => isWithin(path, root) || isWithin(real, root));

export const sandboxReachOf = async (deps: CliDeps) => {
  const effective = await loadEffectiveConfig({ env: deps.env, home: deps.home }).catch(() => undefined);

  return {
    home: deps.home,
    env: deps.env,
    stateDir: pathsOf(deps).stateDir,
    workspaceRoot: effective?.config.workspaceRoot,
  };
};

export const resolveJobPi = async (deps: CliDeps): Promise<HostPi | undefined> => {
  const managed = await locateManagedPi(hostAgentDirOf(deps));

  if (managed !== undefined) {
    return managed;
  }

  const roots = await sandboxWriteRoots(await sandboxReachOf(deps));

  return locateNpmPi({ runner: deps.runner, env: deps.env, home: deps.home, accept: outsideRoots(roots) });
};

export const missingPi = (deps: CliDeps) => ({
  problem: `no managed pi in ${hostAgentDirOf(deps)} and no pi in npm's global packages`,
  ignored: "a pi found only on PATH or in a project's node_modules is not used",
  effect: "the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable",
  fix: "install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) or with npm install -g @earendil-works/pi-coding-agent, and run pinata install again",
});

export const missingPiText = (deps: CliDeps) => {
  const { problem, ignored, effect, fix } = missingPi(deps);

  return `${problem} (${ignored}): ${effect}; ${fix}`;
};

export const requireJobPi = async (deps: CliDeps, prefix?: string) => {
  const pi = await resolveJobPi(deps);

  if (pi === undefined) {
    throw new LauncherError(prefix === undefined ? missingPiText(deps) : `${prefix}: ${missingPiText(deps)}`);
  }

  return pi;
};

export const spawnHostJob = (
  deps: CliDeps,
  pi: HostPi,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) => {
  const [file = "", ...prefix] = pi.hostJob;

  return deps.runner.spawnInteractive(file, [...prefix, ...args], options);
};

export const runHostPi = async (deps: CliDeps, context: LaunchContext, piArgs: string[]) => {
  const pi = await requireJobPi(deps, NO_SANDBOX);

  writeLine(deps.stderr, `pi-sandbox: warning: running ${pi.location} on the host, outside the sandbox`);

  await sweepForHostPi(deps, context);

  return spawnHostJob(deps, pi, piArgs, { cwd: deps.cwd });
};
