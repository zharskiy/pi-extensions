import { isAbsolute } from "node:path";
import {
  type Backend,
  type ContainerSummary,
  installIdOf,
  isSession,
  LABELS,
  roleOf,
} from "../../backend/index.ts";
import {
  agentVolumeName,
  installServices,
  isLegacyAgentVolume,
  mountedVolumes,
  overlayVolumes,
} from "../../container/index.ts";
import { type Launch, liveLaunches } from "../../grants/index.ts";
import { recordedImage } from "../../image/index.ts";
import {
  knownRepos,
  LauncherError,
  lstatOrUndefined,
  repoRecordOf,
  shortHash,
  stateLayout,
} from "../../shared/index.ts";
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

const serviceLines = (context: LaunchContext, found: ContainerSummary[]) => {
  const { services } = context.effective.config;

  if (services.length === 0) {
    return [];
  }

  return [
    `services: ${services.length}`,
    ...services.map((service) => {
      const container = found.find(
        (entry) => roleOf(entry.labels) === "service" && entry.labels[LABELS.serviceName] === service.name,
      );

      const ports = (service.ports ?? []).length === 0 ? "" : ` ports ${(service.ports ?? []).join(",")}`;

      return container === undefined
        ? `service: ${service.name} not started${ports}`
        : `service: ${service.name} ${container.state} (${container.id})${ports}`;
    }),
  ];
};

const containerLines = async (backend: Backend, context: LaunchContext) => {
  const found = await backend.findContainers({ [LABELS.repoHash]: context.repoHash });
  const containers = found.filter((container) => isSession(container.labels));
  const services = await installServices(backend);

  return [
    ...serviceLines(context, services),
    `containers: ${containers.length}`,
    ...containers.flatMap((container) => [
      `container: ${container.id} ${container.state} launch ${container.labels[LABELS.launchId] ?? "unknown"} digest ${container.labels[LABELS.imageDigest] ?? "unknown"}`,
      sessionDirLine(container.labels[LABELS.sessionDir]),
    ]),
  ];
};

const LEFTOVER_HINT = "left by an older launcher; pi sandbox restart removes it";

const leftoverFolders = async (stateDir: string) => {
  const layout = stateLayout(stateDir);
  const legacy = (await knownRepos(stateDir)).map((hash) => layout.repo(hash).legacy.sync);
  const candidates = [layout.renders, ...legacy];
  const found = await Promise.all(
    candidates.map(async (path) => ((await lstatOrUndefined(path)) ? [path] : [])),
  );

  return found.flat().map((path) => `leftover: ${path}, ${LEFTOVER_HINT}`);
};

const piFolderLines = async (backend: Backend, context: LaunchContext) => {
  const install = installIdOf(context.stateDir);
  const shared = agentVolumeName(install);
  const volumes = await backend.listVolumes();
  const created = volumes.some((volume) => volume.name === shared);
  const legacy = volumes.filter((volume) => isLegacyAgentVolume(install, volume.name));

  return [
    created ? `pi folder: ${shared}, shared by every folder's sandbox` : "pi folder: not created yet",
    ...legacy.map((volume) => `leftover: volume ${volume.name}, ${LEFTOVER_HINT}`),
    ...(await leftoverFolders(context.stateDir)),
  ];
};

const runtimeLines = async (deps: CliDeps, context: LaunchContext) => {
  try {
    const backend = await reachableBackend(deps);
    const details = Object.entries(await backend.status()).map(([key, value]) => `runtime ${key}: ${value}`);

    return [
      ...details,
      ...(await containerLines(backend, context)),
      ...(await piFolderLines(backend, context)),
    ];
  } catch (error) {
    if (error instanceof LauncherError) {
      return [`runtime: none (${error.message})`, ...(await leftoverFolders(context.stateDir))];
    }

    throw error;
  }
};

const proxyLines = async (deps: CliDeps, context: LaunchContext) => {
  const proxy = await deps.proxy.read(context.stateDir);

  return [proxy === undefined ? "proxy: stopped" : `proxy: pid ${proxy.pid} port ${proxy.port}`];
};

const imageLine = async (context: LaunchContext) => {
  const { image } = context.effective.config;
  const record = await recordedImage(context.stateDir, context.effective.config);

  return `image: ${record?.reference ?? image.reference ?? "pi-sandbox-base:local"} ${image.digest ?? record?.digest ?? "(not built yet)"}`;
};

const launchLine = async (stateDir: string, launch: Launch) => {
  const root =
    (await repoRecordOf(stateDir, launch.repoHash))?.root ?? `repository ${shortHash(launch.repoHash)}`;

  return `launch: ${launch.launchId} pid ${launch.pid} since ${new Date(launch.startedAt).toISOString()} in ${root}`;
};

const launchLines = async (context: LaunchContext) => {
  const launches = await liveLaunches(context.stateDir);
  const lines = await Promise.all(launches.map((launch) => launchLine(context.stateDir, launch)));

  return [`launches: ${launches.length} running in the sandbox`, ...lines];
};

const volumeLines = (context: LaunchContext) => {
  const { config } = context.effective;
  const overlays = overlayVolumes(context.workspace, config, context.stateDir);
  const volumes = mountedVolumes(config, context.stateDir);

  return [
    `overlays: ${overlays.length}`,
    ...overlays.map((overlay) => `overlay: ${overlay.path} (${overlay.name})`),
    `volumes: ${volumes.length}`,
    ...volumes.map((entry) => `volume: ${entry.target} (${entry.name})`),
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
    `${context.workspace.isGitRepo ? "repo" : "folder"}: ${context.workspace.repoRoot}`,
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
