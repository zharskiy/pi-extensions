import { type Backend, installIdOf, networkName, roleOf } from "../backend/index.ts";
import type { ServiceEntry } from "../config/index.ts";
import {
  discardContainer,
  ensureServices,
  listLauncherContainers,
  type ServicesInput,
  serviceVolumes,
  stopServices,
} from "../container/index.ts";
import { removeProxyToken } from "../proxy/index.ts";
import { LauncherError, stateLayout, withFileLockUnless, withWaitingLock } from "../shared/index.ts";
import { busyLaunches } from "./busy.ts";
import { type CliDeps, pathsOf, writeLine } from "./deps.ts";

export const GROUND_WAITING =
  "pi-sandbox: waiting for another pi session to finish with the sandbox network, proxy or services";

export const CLEANUP_WAITING =
  "pi-sandbox: waiting for another pi-sandbox command to finish before cleaning up";

export const cleanupWaiting = (signal?: AbortSignal) =>
  signal === undefined ? CLEANUP_WAITING : `${CLEANUP_WAITING}; Ctrl-C skips the cleanup`;

interface GroundLock {
  stateDir: string;
  signal?: AbortSignal;
  progress?: (line: string) => void;
}

export const withGroundLock = <T>(lock: GroundLock, action: () => Promise<T>) =>
  withWaitingLock(stateLayout(lock.stateDir).groundLock, action, {
    signal: lock.signal,
    onWait: () => lock.progress?.(GROUND_WAITING),
  });

type LaunchServicesInput = Omit<ServicesInput, "othersLive"> & { launchId: string };

export const startServices = (input: LaunchServicesInput) => {
  if (input.services.length === 0) {
    return Promise.resolve();
  }

  const lock = { stateDir: input.stateDir, signal: input.signal, progress: input.report };

  return withGroundLock(lock, () =>
    ensureServices({
      ...input,
      othersLive: async () => (await busyLaunches(input.stateDir, input.launchId)) > 0,
    }),
  );
};

const removedLines = (containers: Array<{ name: string; id: string }>) =>
  containers.map((container) => `removed container ${container.name} (${container.id})`);

const removeRelays = async (backend: Backend) => {
  const containers = await listLauncherContainers(backend);
  const relays = containers.filter((container) => roleOf(container.labels) === "relay");

  await Promise.all(relays.map((relay) => discardContainer(backend, relay)));

  return relays.map((relay) => `removed relay ${relay.name}`);
};

const removeNetwork = async (backend: Backend, stateDir: string) => {
  const removed = await backend.removeNetwork().catch(() => false);

  return removed ? [`removed network ${networkName(installIdOf(stateDir))}`] : [];
};

const removeEngineGround = async (backend: Backend, stateDir: string) => {
  if (!(await backend.detect()).available) {
    return [];
  }

  const services = removedLines(await stopServices(backend));
  const relays = await removeRelays(backend);
  const network = await removeNetwork(backend, stateDir);

  return [...services, ...relays, ...network];
};

const stopInstallProxy = async (deps: CliDeps, stateDir: string) => {
  const stopped = await deps.proxy.stop(stateDir);

  await removeProxyToken(stateDir);

  return stopped ? ["stopped the proxy"] : [];
};

export const removeGround = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  const engine =
    backend === undefined ? [] : await removeEngineGround(backend, stateDir).catch((error: unknown) => error);
  const proxy = await stopInstallProxy(deps, stateDir);

  if (!Array.isArray(engine)) {
    throw engine;
  }

  return [...engine, ...proxy];
};

const removeIdleGround = async (deps: CliDeps, backend: Backend) => {
  const stateDir = pathsOf(deps).stateDir;

  if ((await busyLaunches(stateDir)) > 0) {
    return [];
  }

  return removeGround(deps, stateDir, backend);
};

const whenGroundIdle = async (deps: CliDeps, action: () => Promise<string[]>, signal?: AbortSignal) => {
  const stateDir = pathsOf(deps).stateDir;
  const outcome = await withFileLockUnless(stateLayout(stateDir).groundLock, action, {
    skip: async () => (await busyLaunches(stateDir)) > 0,
    signal,
    onWait: () => writeLine(deps.stderr, cleanupWaiting(signal)),
  });

  return outcome.busy ? [] : outcome.value;
};

export const stopIdleGround = (deps: CliDeps, backend: Backend, signal?: AbortSignal) =>
  whenGroundIdle(deps, () => removeIdleGround(deps, backend), signal);

const BUSY_HINT = "end every pi session, then run this again";

export const wipeServices = (
  backend: Backend,
  stateDir: string,
  parts: { services: ServiceEntry[]; progress: (line: string) => void },
) =>
  withGroundLock({ stateDir, progress: parts.progress }, async () => {
    if ((await busyLaunches(stateDir)) > 0) {
      throw new LauncherError("a pi session is running, so the services were kept", BUSY_HINT);
    }

    const removed = removedLines(await stopServices(backend));
    const volumes = await serviceVolumes(backend, stateDir, parts.services);

    await Promise.all(volumes.map((volume) => backend.removeVolume(volume.name)));

    return [...removed, ...volumes.map((volume) => `removed volume ${volume.name}`)];
  });
