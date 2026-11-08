import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import { selectBackend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { errorMessage, LauncherError, withDirectoryLock } from "../shared/index.ts";
import { type CliDeps, withFallbackHint, writeNotices } from "./deps.ts";

type Detection = Awaited<ReturnType<Backend["detect"]>>;

export const OWN_PROFILE = "pi-sandbox";

const LOCK_TIMEOUT_MS = 180_000;

const DETECT_DELAYS_MS = [0, 500, 1000, 1500, 2000];

export const instanceOf = (profile: string) => (profile === "default" ? "colima" : `colima-${profile}`);

export const plainStart = (profile: string) => `colima start --profile ${profile} --activate=false`;

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const logHint = (profile: string) => `~/.colima/_lima/${instanceOf(profile)}/ha.stderr.log`;

const startHint = `run ${plainStart(OWN_PROFILE)} and see ${logHint(OWN_PROFILE)}`;

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

const colimaAdapter = (deps: CliDeps) => deps.adapters().find((adapter) => adapter.name === "colima");

const detectColima = async (deps: CliDeps): Promise<Detection> =>
  (await colimaAdapter(deps)?.detect()) ?? { available: false, reason: "no adapter on this host" };

const mayStart = async (deps: CliDeps, config: SandboxConfig) =>
  (config.backend === "auto" || config.backend === "colima") &&
  deps.env.DOCKER_HOST === undefined &&
  colimaAdapter(deps) !== undefined &&
  (await ownProfileExists(deps));

const startFailure = "could not start the sandbox VM";

const startStopped = async (deps: CliDeps) => {
  if ((await detectColima(deps)).available) {
    return;
  }

  writeNotices(deps, ["starting the sandbox VM"]);

  await runColima(deps, startFailure, ["start", "--profile", OWN_PROFILE, "--activate=false"], startHint);

  const detection = await detectAgain(() => detectColima(deps));

  if (detection?.available !== true) {
    throw new LauncherError(
      `the sandbox VM started but its engine is unreachable: ${detection?.reason ?? "not detected"}`,
      startHint,
    );
  }
};

const startWhenStopped = async (deps: CliDeps, stateDir: string) => {
  if ((await detectColima(deps)).available || (await vmRunning(deps, startFailure))) {
    return false;
  }

  await withVmLock(stateDir, () => startStopped(deps));

  return true;
};

const startedBackend = async (deps: CliDeps, config: SandboxConfig, stateDir: string) =>
  (await mayStart(deps, config)) && (await startWhenStopped(deps, stateDir))
    ? selectBackend(config.backend, deps.adapters())
    : undefined;

const launchBackend = async (deps: CliDeps, config: SandboxConfig, stateDir: string) => {
  const selection = await selectBackend(config.backend, deps.adapters()).then(
    (backend) => ({ backend }),
    (error: unknown) => ({ error }),
  );

  if ("backend" in selection && selection.backend.name === "colima") {
    return selection.backend;
  }

  const started = await startedBackend(deps, config, stateDir);

  if (started !== undefined) {
    return started;
  }

  if ("error" in selection) {
    throw selection.error;
  }

  return selection.backend;
};

export const openLaunchBackend = async (deps: CliDeps, config: SandboxConfig, stateDir: string) => {
  try {
    return await launchBackend(deps, config, stateDir);
  } catch (error) {
    throw withFallbackHint(error, config.fallback);
  }
};
