import { isAbsolute } from "node:path";
import { type Backend, LABELS } from "../../backend/index.ts";
import { overlayVolumes, sharedCacheVolumes } from "../../container/index.ts";
import { liveLaunches } from "../../grants/index.ts";
import { recordedImage } from "../../image/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, reachableBackend, writeLines } from "../deps.ts";
import { launcherVersion } from "../versions.ts";
import { grantLines } from "./egress.ts";

const sessionDirLine = (label: string | undefined) => {
  if (label === undefined) {
    return "session dir: sandbox volume";
  }

  return isAbsolute(label) ? `session dir: ${label}` : `session dir: sandbox volume (${label})`;
};

const containerLines = async (backend: Backend, context: LaunchContext) => {
  const containers = (
    await backend.findContainers({ [LABELS.managed]: "true", [LABELS.repoHash]: context.repoHash })
  ).filter((container) => container.labels[LABELS.relay] === undefined);

  return [
    `containers: ${containers.length}`,
    ...containers.flatMap((container) => [
      `container: ${container.id} ${container.state} launch ${container.labels[LABELS.launchId] ?? "unknown"} digest ${container.labels[LABELS.imageDigest] ?? "unknown"}`,
      sessionDirLine(container.labels[LABELS.sessionDir]),
    ]),
  ];
};

const runtimeLines = async (deps: CliDeps, context: LaunchContext) => {
  try {
    const backend = await reachableBackend(deps);
    const details = Object.entries(await backend.status()).map(([key, value]) => `runtime ${key}: ${value}`);

    return [...details, ...(await containerLines(backend, context))];
  } catch (error) {
    if (error instanceof LauncherError) {
      return [`runtime: none (${error.message})`];
    }

    throw error;
  }
};

const proxyLines = async (deps: CliDeps, context: LaunchContext) => {
  const proxy = await deps.proxy.read(context.stateDir, context.repoHash);

  return [proxy === undefined ? "proxy: stopped" : `proxy: pid ${proxy.pid} port ${proxy.port}`];
};

const imageLine = async (context: LaunchContext) => {
  const { image } = context.effective.config;
  const record = await recordedImage(context.stateDir, context.effective.config);

  return `image: ${record?.reference ?? image.reference ?? "pi-sandbox-base:local"} ${image.digest ?? record?.digest ?? "(not built yet)"}`;
};

const launchLines = async (context: LaunchContext) => {
  const launches = await liveLaunches(context.stateDir, context.repoHash);

  return [
    `launches: ${launches.length} running in ${context.workspace.repoRoot}`,
    ...launches.map(
      (launch) =>
        `launch: ${launch.launchId} pid ${launch.pid} since ${new Date(launch.startedAt).toISOString()}`,
    ),
  ];
};

const volumeLines = (context: LaunchContext) => {
  const { config } = context.effective;
  const overlays = overlayVolumes(context.workspace, config);
  const shared = sharedCacheVolumes(config, context.stateDir);

  return [
    `overlays: ${overlays.length}`,
    ...overlays.map((overlay) => `overlay: ${overlay.path} (${overlay.name})`),
    `shared caches: ${shared.length}`,
    ...shared.map((cache) => `shared cache: ${cache.path} (${cache.name})`),
  ];
};

const grantStatus = async (context: LaunchContext) => {
  const lines = await grantLines(context);

  return [`grants: ${lines.length} active`, ...lines.map((line) => `grant: ${line}`)];
};

export const statusCommand = async (deps: CliDeps) => {
  const { context } = await openContext(deps, "host", { overlays: true });
  const lines = [
    `launcher: ${await launcherVersion()}`,
    `${context.workspace.isGitRepo ? "repo" : "workspace"}: ${context.workspace.repoRoot}`,
    ...(await runtimeLines(deps, context)),
    ...(await proxyLines(deps, context)),
    await imageLine(context),
    ...volumeLines(context),
    ...(await launchLines(context)),
    ...(await grantStatus(context)),
  ];

  writeLines(deps.stdout, lines);

  return 0;
};
