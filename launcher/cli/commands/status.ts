import type { Backend, BackendCapabilities } from "../../backend/index.ts";
import { configHash } from "../../config/index.ts";
import { findCurrentContainer, findRepoContainer, LABELS } from "../../container/index.ts";
import { liveSessions } from "../../grants/index.ts";
import { recordedImage } from "../../image/index.ts";
import { proxyPolicyHash } from "../../proxy/index.ts";
import { LauncherError, sha256Hex } from "../../shared/index.ts";
import { type CliDeps, writeLines } from "../deps.ts";
import { type LaunchContext, openBackend, openContext } from "../launch.ts";
import { launcherVersion } from "../versions.ts";
import { grantLines } from "./egress.ts";

const GAPS: Record<keyof BackendCapabilities, string> = {
  singleFileMount:
    "no single-file mounts, git config files and the trust bundle are mounted from read-only copies",
  sshAgent: "no ssh agent forwarding, ssh.agent has no effect",
  internalNetwork: "no internal network, the container cannot reach the egress proxy",
};

const SHORT_HASH = 12;

const gapLines = (capabilities: BackendCapabilities) =>
  (Object.keys(GAPS) as Array<keyof BackendCapabilities>)
    .filter((name) => !capabilities[name])
    .map((name) => `gap: ${GAPS[name]}`);

const containerLines = async (backend: Backend, context: LaunchContext) => {
  const container = await findRepoContainer(backend, context.workspace);

  if (container === undefined) {
    return ["container: none"];
  }

  const { config } = context.effective;
  const hash = container.labels[LABELS.configHash] ?? "unknown";
  const record = await recordedImage(context.stateDir, config);
  const current = await findCurrentContainer(
    backend,
    context.workspace,
    record?.digest ?? "",
    configHash(config),
  );
  const freshness = current?.id === container.id ? "current" : "stale";

  return [
    `container: ${container.id} ${container.state}`,
    `container digest: ${container.labels[LABELS.imageDigest] ?? "unknown"}`,
    `container config hash: ${hash} (${freshness})`,
  ];
};

const backendLines = async (deps: CliDeps, context: LaunchContext) => {
  try {
    const backend = await openBackend(deps, context.effective.config);
    const detection = await backend.detect();
    const details = Object.entries(await backend.status()).map(([key, value]) => `backend ${key}: ${value}`);

    return [
      `backend: ${backend.name} ${detection.version ?? "unknown"}`,
      ...details,
      ...(await containerLines(backend, context)),
      ...gapLines(backend.capabilities),
    ];
  } catch (error) {
    if (error instanceof LauncherError) {
      return [`backend: none (${error.message})`];
    }

    throw error;
  }
};

const proxyLines = async (deps: CliDeps, context: LaunchContext) => {
  const instances = await deps.proxy.list(context.stateDir);
  const wanted = proxyPolicyHash(context.effective.config, context.effective.egressCap);

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

const sessionLines = async (context: LaunchContext) => {
  const sessions = await liveSessions(context.stateDir, sha256Hex(context.workspace.repoRoot));

  return [
    `sessions: ${sessions.length} running for this repository`,
    ...sessions.map(
      (session) =>
        `session: ${session.launchId} pid ${session.pid} since ${new Date(session.startedAt).toISOString()}`,
    ),
  ];
};

const grantStatus = async (deps: CliDeps, context: LaunchContext) => {
  if (!context.effective.config.egress.grants.enabled) {
    return ["grants: turned off by egress.grants.enabled"];
  }

  const lines = await grantLines(deps, context);

  return [`grants: ${lines.length} active`, ...lines.map((line) => `grant: ${line}`)];
};

export const statusCommand = async (deps: CliDeps) => {
  const context = await openContext(deps);
  const lines = [
    `launcher: ${await launcherVersion()}`,
    `repo: ${context.workspace.repoRoot}`,
    ...(await backendLines(deps, context)),
    ...(await proxyLines(deps, context)),
    await imageLine(context),
    ...(await sessionLines(context)),
    ...(await grantStatus(deps, context)),
  ];

  writeLines(deps.stdout, lines);

  return 0;
};
