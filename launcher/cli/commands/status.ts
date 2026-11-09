import { isAbsolute } from "node:path";
import type { Backend } from "../../backend/index.ts";
import {
  findRepoContainer,
  isCurrentContainer,
  LABELS,
  nodeModulesOverlays,
  sharedCacheVolumes,
} from "../../container/index.ts";
import { liveLaunches } from "../../grants/index.ts";
import { recordedImage } from "../../image/index.ts";
import { proxyPolicyHash } from "../../proxy/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, reachableBackend, writeLines } from "../deps.ts";
import { type LaunchContext, openContext } from "../launch.ts";
import { launcherVersion } from "../versions.ts";
import { grantLines } from "./egress.ts";

const SHORT_HASH = 12;

const sessionDirLine = (label: string | undefined) => {
  if (label === undefined) {
    return "session dir: sandbox volume";
  }

  return isAbsolute(label) ? `session dir: ${label}` : `session dir: sandbox volume (${label})`;
};

const containerLines = async (backend: Backend, context: LaunchContext) => {
  const container = await findRepoContainer(backend, context.workspace);

  if (container === undefined) {
    return ["container: none"];
  }

  const { config } = context.effective;
  const hash = container.labels[LABELS.specHash] ?? "unknown";
  const record = await recordedImage(context.stateDir, config);
  const current = await isCurrentContainer(container, {
    stateDir: context.stateDir,
    repoRoot: context.workspace.repoRoot,
    digest: record?.digest ?? "",
  });
  const freshness = current ? "current" : "stale";

  return [
    `container: ${container.id} ${container.state}`,
    `container digest: ${container.labels[LABELS.imageDigest] ?? "unknown"}`,
    `container spec hash: ${hash} (${freshness})`,
    sessionDirLine(container.labels[LABELS.sessionDir]),
  ];
};

const runtimeLines = async (deps: CliDeps, context: LaunchContext) => {
  try {
    const backend = await reachableBackend(deps, context.effective.config);
    const detection = await backend.detect();
    const details = Object.entries(await backend.status()).map(([key, value]) => `runtime ${key}: ${value}`);

    return [
      `runtime: colima ${detection.version ?? "unknown"}`,
      ...details,
      ...(await containerLines(backend, context)),
    ];
  } catch (error) {
    if (error instanceof LauncherError) {
      return [`runtime: none (${error.message})`];
    }

    throw error;
  }
};

const proxyLines = async (deps: CliDeps, context: LaunchContext) => {
  const instances = await deps.proxy.list(context.stateDir);
  const wanted = proxyPolicyHash(context.effective.config);

  if (instances.length === 0) {
    return ["proxy: stopped"];
  }

  return instances.map(
    (instance) =>
      `proxy: policy ${instance.policyHash.slice(0, SHORT_HASH)} pid ${instance.pid} port ${instance.port} (${instance.policyHash === wanted ? "this repository" : "other policy"})`,
  );
};

const imageLine = async (context: LaunchContext) => {
  const { image } = context.effective.config;
  const record = await recordedImage(context.stateDir, context.effective.config);

  return `image: ${image.reference} ${image.digest ?? record?.digest ?? "(not built yet)"}`;
};

const launchLines = async (context: LaunchContext) => {
  const launches = await liveLaunches(context.stateDir, context.repoHash);

  return [
    `launches: ${launches.length} running for this repository`,
    ...launches.map(
      (launch) =>
        `launch: ${launch.launchId} pid ${launch.pid} since ${new Date(launch.startedAt).toISOString()}`,
    ),
  ];
};

const volumeLines = (context: LaunchContext) => {
  const { config } = context.effective;
  const overlays = nodeModulesOverlays(context.workspace, config);
  const shared = sharedCacheVolumes(config, context.stateDir);

  return [
    `node_modules overlays: ${overlays.length}`,
    ...overlays.map((overlay) => `node_modules overlay: ${overlay.path} (${overlay.name})`),
    `shared caches: ${shared.length}`,
    ...shared.map((cache) => `shared cache: ${cache.path} (${cache.name})`),
  ];
};

const grantStatus = async (context: LaunchContext) => {
  if (!context.effective.config.egress.grants) {
    return ["grants: turned off by egress.grants"];
  }

  const lines = await grantLines(context);

  return [`grants: ${lines.length} active`, ...lines.map((line) => `grant: ${line}`)];
};

export const statusCommand = async (deps: CliDeps) => {
  const { context } = await openContext(deps, "host");
  const lines = [
    `launcher: ${await launcherVersion()}`,
    `repo: ${context.workspace.repoRoot}`,
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
