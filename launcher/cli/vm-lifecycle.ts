import { access } from "node:fs/promises";
import { join } from "node:path";
import { type Backend, ENGINE_PROFILE, ENGINE_SOCKET_DISPLAY } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { errorMessage, LauncherError, withDirectoryLock } from "../shared/index.ts";
import { type CliDeps, withFallbackHint, writeNotices } from "./deps.ts";

type Detection = Awaited<ReturnType<Backend["detect"]>>;

export const OWN_PROFILE = ENGINE_PROFILE;

const LOCK_TIMEOUT_MS = 180_000;

const DETECT_DELAYS_MS = [0, 500, 1000, 1500, 2000];

export const instanceOf = (profile: string) => `colima-${profile}`;

export const plainStart = (profile: string) => `colima start --profile ${profile} --activate=false`;

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const logHint = (profile: string) => `~/.colima/_lima/${instanceOf(profile)}/ha.stderr.log`;

const startHint = `run ${plainStart(OWN_PROFILE)} and see ${logHint(OWN_PROFILE)}`;

const unreachableHint = `run launcher/install.sh or ${plainStart(OWN_PROFILE)}`;

const unreachable = () =>
  new LauncherError(`the sandbox VM engine is unreachable at ${ENGINE_SOCKET_DISPLAY}`, unreachableHint);

export const withVmLock = <T>(stateDir: string, action: () => Promise<T>) =>
  withDirectoryLock(join(stateDir, "locks", "vm.lock"), action, { timeoutMs: LOCK_TIMEOUT_MS });

export const runColima = async (deps: CliDeps, failure: string, args: string[], hint: string) => {
  const result = await deps.runner.run("colima", args).catch((error: unknown) => {
    throw new LauncherError(
      `${failure}: ${errorMessage(error)}`,
      error instanceof LauncherError ? error.hint : undefined,
    );
  });

  if (result.code !== 0) {
    throw new LauncherError(
      `${failure}: colima ${args[0]} failed: ${lastLine(result.stderr) || `exit ${result.code}`}`,
      hint,
    );
  }
};

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const detectAgain = (detect: () => Promise<Detection>) =>
  DETECT_DELAYS_MS.reduce<Promise<Detection | undefined>>(async (previous, delay) => {
    const last = await previous;

    if (last?.available === true) {
      return last;
    }

    await pause(delay);

    return detect();
  }, Promise.resolve(undefined));

export const ownProfileExists = (deps: CliDeps) =>
  access(join(deps.home, ".colima", OWN_PROFILE, "colima.yaml")).then(
    () => true,
    () => false,
  );

export const vmRunning = async (deps: CliDeps, failure: string) => {
  const result = await deps.runner
    .run("colima", ["status", "--profile", OWN_PROFILE])
    .catch((error: unknown) => {
      throw new LauncherError(`${failure}: ${errorMessage(error)}`, "run launcher/install.sh");
    });

  return result.code === 0;
};

export const reachableBackend = async (deps: CliDeps) => {
  const backend = deps.backend();

  if ((await backend.detect()).available) {
    return backend;
  }

  throw unreachable();
};

const startFailure = "could not start the sandbox VM";

const startStopped = async (deps: CliDeps, backend: Backend) => {
  if ((await backend.detect()).available) {
    return;
  }

  writeNotices(deps, ["starting the sandbox VM"]);

  await runColima(deps, startFailure, ["start", "--profile", OWN_PROFILE, "--activate=false"], startHint);

  const detection = await detectAgain(() => backend.detect());

  if (detection?.available !== true) {
    throw new LauncherError(
      `the sandbox VM started but its engine is unreachable: ${detection?.reason ?? "not detected"}`,
      startHint,
    );
  }
};

const startWhenStopped = async (deps: CliDeps, backend: Backend, stateDir: string) => {
  if ((await backend.detect()).available || (await vmRunning(deps, startFailure))) {
    return false;
  }

  await withVmLock(stateDir, () => startStopped(deps, backend));

  return true;
};

const launchBackend = async (deps: CliDeps, stateDir: string) => {
  const backend = deps.backend();

  if ((await backend.detect()).available) {
    return backend;
  }

  if ((await ownProfileExists(deps)) && (await startWhenStopped(deps, backend, stateDir))) {
    return backend;
  }

  throw unreachable();
};

export const openLaunchBackend = async (deps: CliDeps, config: SandboxConfig, stateDir: string) => {
  try {
    return await launchBackend(deps, stateDir);
  } catch (error) {
    throw withFallbackHint(error, config.fallback);
  }
};
