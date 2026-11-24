import { isAbsolute } from "node:path";
import {
  type Backend,
  type ContainerSummary,
  installIdOf,
  isSession,
  LABELS,
  roleOf,
} from "../../backend/index.ts";
import { agentVolumeName, installServices, mountedVolumes, overlayVolumes } from "../../container/index.ts";
import { type Launch, liveLaunches } from "../../grants/index.ts";
import { recordedImage } from "../../image/index.ts";
import { LauncherError, repoRecordOf, shortHash } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, reachableBackend } from "../deps.ts";
import { stepsOf, tilde } from "../steps.ts";
import { launcherVersion } from "../versions.ts";
import { grantLines } from "./egress.ts";

type Row = [string, string];

const listed = (label: string, items: string[], empty?: string): Row[] => {
  if (items.length === 0) {
    return empty === undefined ? [] : [[label, empty]];
  }

  return items.map((item, index) => [index === 0 ? label : "", item]);
};

const shownPath = (deps: CliDeps, text: string) => (isAbsolute(text) ? tilde(deps, text) : text);

const sessionsText = (deps: CliDeps, label: string | undefined) => {
  if (label === undefined) {
    return "sessions in the sandbox volume";
  }

  return isAbsolute(label)
    ? `sessions in ${tilde(deps, label)}`
    : `sessions in the sandbox volume (${label})`;
};

const serviceRows = (context: LaunchContext, found: ContainerSummary[]) => {
  const services = context.effective.config.services.map((service) => {
    const container = found.find(
      (entry) => roleOf(entry.labels) === "service" && entry.labels[LABELS.serviceName] === service.name,
    );
    const ports = (service.ports ?? []).length === 0 ? "" : `, ports ${(service.ports ?? []).join(",")}`;

    return container === undefined
      ? `${service.name}, not started${ports}`
      : `${service.name}, ${container.state} (${container.id})${ports}`;
  });

  return listed("Services", services);
};

const containerRows = async (deps: CliDeps, backend: Backend, context: LaunchContext) => {
  const found = await backend.findContainers({ [LABELS.repoHash]: context.repoHash });
  const containers = found
    .filter((container) => isSession(container.labels))
    .map((container) =>
      [
        container.id,
        container.state,
        `launch ${container.labels[LABELS.launchId] ?? "unknown"}`,
        `digest ${container.labels[LABELS.imageDigest] ?? "unknown"}`,
        sessionsText(deps, container.labels[LABELS.sessionDir]),
      ].join(", "),
    );

  return [
    ...serviceRows(context, await installServices(backend)),
    ...listed("Containers", containers, "none"),
  ];
};

const piFolderRow = async (backend: Backend, context: LaunchContext): Promise<Row> => {
  const shared = agentVolumeName(installIdOf(context.stateDir));
  const volumes = await backend.listVolumes();
  const created = volumes.some((volume) => volume.name === shared);

  return ["Pi folder", created ? `${shared}, shared by every folder's sandbox` : "not created yet"];
};

const runtimeRows = async (deps: CliDeps, context: LaunchContext): Promise<Row[]> => {
  try {
    const backend = await reachableBackend(deps);
    const details = Object.entries(await backend.status())
      .map(([key, value]) => `${key} ${shownPath(deps, value)}`)
      .join(", ");

    return [
      ["Runtime", details],
      ...(await containerRows(deps, backend, context)),
      await piFolderRow(backend, context),
    ];
  } catch (error) {
    if (error instanceof LauncherError) {
      return [["Runtime", error.message]];
    }

    throw error;
  }
};

const proxyRow = async (deps: CliDeps, context: LaunchContext): Promise<Row> => {
  const proxy = await deps.proxy.read(context.stateDir);

  return ["Proxy", proxy === undefined ? "stopped" : `pid ${proxy.pid}, port ${proxy.port}`];
};

const imageRow = async (context: LaunchContext): Promise<Row> => {
  const { image } = context.effective.config;
  const record = await recordedImage(context.stateDir, context.effective.config);
  const reference = record?.reference ?? image.reference ?? "pinata-base:local";
  const digest = image.digest ?? record?.digest;

  return ["Image", digest === undefined ? `${reference}, not built yet` : `${reference} ${digest}`];
};

const launchText = async (deps: CliDeps, stateDir: string, launch: Launch) => {
  const record = await repoRecordOf(stateDir, launch.repoHash);
  const root = record === undefined ? `repository ${shortHash(launch.repoHash)}` : tilde(deps, record.root);

  return `${launch.launchId}, pid ${launch.pid}, since ${new Date(launch.startedAt).toISOString()}, in ${root}`;
};

const launchRows = async (deps: CliDeps, context: LaunchContext) => {
  const launches = await liveLaunches(context.stateDir);
  const texts = await Promise.all(launches.map((launch) => launchText(deps, context.stateDir, launch)));

  return listed("Launches", texts, "none");
};

const volumeRows = (deps: CliDeps, context: LaunchContext) => {
  const { config } = context.effective;
  const overlays = overlayVolumes(context.workspace, config, context.stateDir);
  const volumes = mountedVolumes(config, context.stateDir);

  return [
    ...listed(
      "Overlays",
      overlays.map((overlay) => `${tilde(deps, overlay.path)} (${overlay.name})`),
    ),
    ...listed(
      "Volumes",
      volumes.map((entry) => `${entry.target} (${entry.name})`),
    ),
  ];
};

export const statusCommand = async (deps: CliDeps) => {
  const { context } = await openContext(deps, "host", { overlays: true });
  const kind = context.workspace.isGitRepo ? "repository" : "folder";
  const rows = [
    ...(await runtimeRows(deps, context)),
    await proxyRow(deps, context),
    await imageRow(context),
    ...volumeRows(deps, context),
    ...(await launchRows(deps, context)),
    ...listed("Grants", await grantLines(context), "none"),
  ];

  stepsOf(deps).close(
    `Pinata ${await launcherVersion()} for the ${kind} ${tilde(deps, context.workspace.repoRoot)}.`,
    rows,
  );

  return 0;
};
