import { type HostPi, locateManagedPi } from "../hostpi/index.ts";
import { LauncherError, PI_AGENT_DIR_VARIABLE, withMcpLoginDir } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeNotices } from "./deps.ts";
import { sweepForHostPi } from "./host-sessions.ts";

export const NO_SANDBOX = "--no-sandbox";

export const hostPiEnv = (deps: CliDeps) => ({ [PI_AGENT_DIR_VARIABLE]: hostAgentDirOf(deps) });

export const runHostJob = (
  deps: CliDeps,
  [file = "", ...args]: string[],
  where: "cwd" | "empty",
  env?: Record<string, string>,
) =>
  where === "cwd"
    ? deps.runner.spawnInteractive(file, args, { cwd: deps.cwd, env })
    : withMcpLoginDir(pathsOf(deps).stateDir, (cwd) =>
        deps.runner.spawnInteractive(file, args, { cwd, env }),
      );

export const resolveJobPi = (deps: CliDeps): Promise<HostPi | undefined> =>
  locateManagedPi(hostAgentDirOf(deps));

export const missingPi = (deps: CliDeps) => ({
  problem: `no managed pi in ${hostAgentDirOf(deps)}`,
  ignored: "a pi installed with npm or found on PATH is not used",
  effect: "the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable",
  fix: "install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run the launcher's install.sh again",
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

export const runHostPi = async (deps: CliDeps, context: LaunchContext, piArgs: string[]) => {
  const pi = await requireJobPi(deps, NO_SANDBOX);

  writeNotices(deps, [`warning: running ${pi.wrapper} on the host, outside the sandbox`]);

  await sweepForHostPi(deps, context);

  return runHostJob(deps, [pi.wrapper, ...piArgs], "cwd");
};
