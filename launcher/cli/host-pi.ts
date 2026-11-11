import { type HostPi, locateManagedPi } from "../hostpi/index.ts";
import { LauncherError } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "./deps.ts";
import { sweepForHostPi } from "./host-sessions.ts";

export const NO_SANDBOX = "--no-sandbox";

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
  const { config, sources } = context.effective;

  if (config.fallback === "refuse") {
    throw new LauncherError(
      `${NO_SANDBOX} is refused: fallback is "refuse", set by ${sources.fallback ?? "default"}`,
      "run pi without --no-sandbox",
    );
  }

  const pi = await requireJobPi(deps, NO_SANDBOX);

  writeLine(deps.stderr, `pi-sandbox: warning: running ${pi.wrapper} on the host, outside the sandbox`);

  await sweepForHostPi(deps, context);

  return deps.runner.spawnInteractive(pi.wrapper, piArgs, { cwd: deps.cwd });
};
