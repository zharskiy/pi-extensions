import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, ContainerSummary, MountSpec } from "../backend/index.ts";
import { sha256Hex } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { LABELS, repoHash } from "./names.ts";
import type { LauncherContainerSpec, RequiredCopy } from "./spec.ts";

export interface EnsureContainerInput {
  backend: Backend;
  spec: LauncherContainerSpec;
}

export interface Garbage {
  containers: ContainerSummary[];
  relays: ContainerSummary[];
  policyHashesInUse: string[];
}

const MANAGED = { [LABELS.managed]: "true" };

const RELAYS = { [LABELS.relay]: "true" };

const IDENTITY = [LABELS.imageDigest, LABELS.configHash, LABELS.specHash];

const isCurrent = (container: ContainerSummary, spec: LauncherContainerSpec) =>
  IDENTITY.every((label) => container.labels[label] === spec.labels[label]);

const discard = async (backend: Backend, container: ContainerSummary) => {
  if (container.state === "running") {
    await backend.stopContainer(container.id);
  }

  await backend.removeContainer(container.id);
};

const placeCopy = async (copy: RequiredCopy, directory: string): Promise<MountSpec> => {
  const placed = join(directory, sha256Hex(copy.target).slice(0, 12));

  await copyFile(copy.source, placed);

  return { source: placed, target: copy.target, readOnly: true, kind: "bind" };
};

const placeCopies = async (spec: LauncherContainerSpec) => {
  if (spec.requiredCopies.length === 0) {
    return [];
  }

  await mkdir(spec.copiesDir, { recursive: true });

  return Promise.all(spec.requiredCopies.map((copy) => placeCopy(copy, spec.copiesDir)));
};

const runtimeSpec = ({ requiredCopies: _copies, copiesDir: _dir, ...spec }: LauncherContainerSpec) => spec;

const createFresh = async (backend: Backend, spec: LauncherContainerSpec) => {
  const copied = await placeCopies(spec);
  const mounts = [...spec.mounts, ...copied];

  await Promise.all(
    mounts.filter((mount) => mount.kind === "volume").map((mount) => backend.ensureVolume(mount.source)),
  );

  const { id } = await backend.createContainer({ ...runtimeSpec(spec), mounts });

  await backend.startContainer(id);

  return { id, created: true };
};

export const ensureContainer = async ({ backend, spec }: EnsureContainerInput) => {
  const existing = await backend.findContainers({ [LABELS.repoHash]: spec.labels[LABELS.repoHash] ?? "" });
  const current = existing.find((container) => isCurrent(container, spec));

  await Promise.all(
    existing.filter((container) => container !== current).map((container) => discard(backend, container)),
  );

  if (current === undefined) {
    return createFresh(backend, spec);
  }

  await placeCopies(spec);

  if (current.state !== "running") {
    await backend.startContainer(current.id);
  }

  return { id: current.id, created: false };
};

export const stopIdleContainer = async (backend: Backend, containerId: string) => {
  const found = (await backend.findContainers(MANAGED)).find((container) => container.id === containerId);

  if (found?.state !== "running") {
    return { stopped: false };
  }

  await backend.stopContainer(found.id);

  return { stopped: true };
};

export const findCurrentContainer = async (
  backend: Backend,
  workspace: Workspace,
  digest: string,
  configHash: string,
) => {
  const [found] = await backend.findContainers({
    [LABELS.repoHash]: repoHash(workspace.repoRoot),
    [LABELS.imageDigest]: digest,
    [LABELS.configHash]: configHash,
  });

  return found;
};

export const findRepoContainer = async (backend: Backend, workspace: Workspace) => {
  const [found] = await backend.findContainers({ [LABELS.repoHash]: repoHash(workspace.repoRoot) });

  return found;
};

const isAgent = (container: ContainerSummary) => container.labels[LABELS.relay] !== "true";

export const listLauncherContainers = async (backend: Backend) =>
  (await backend.findContainers(MANAGED)).filter(isAgent);

export const removeRepoContainer = async (backend: Backend, repoRoot: string) => {
  const existing = await backend.findContainers({ [LABELS.repoHash]: repoHash(repoRoot) });

  await Promise.all(existing.map((container) => discard(backend, container)));

  return existing;
};

const policyHashesOf = (containers: ContainerSummary[]) => [
  ...new Set(
    containers.flatMap((container) => {
      const hash = container.labels[LABELS.proxyPolicyHash];

      return hash === undefined ? [] : [hash];
    }),
  ),
];

const runningPolicyHashes = (agents: ContainerSummary[]) =>
  policyHashesOf(agents.filter((container) => container.state === "running"));

export const policyHashesInUse = async (backend: Backend) =>
  runningPolicyHashes(await listLauncherContainers(backend));

export const collectGarbage = async (backend: Backend): Promise<Garbage> => {
  const agents = await listLauncherContainers(backend);
  const stopped = agents.filter((container) => container.state !== "running");
  const inUse = runningPolicyHashes(agents);

  await Promise.all(stopped.map((container) => backend.removeContainer(container.id)));

  const relays = (await backend.findContainers(RELAYS)).filter(
    (relay) => !inUse.includes(relay.labels[LABELS.proxyPolicyHash] ?? ""),
  );

  await Promise.all(relays.map((relay) => discard(backend, relay)));

  return { containers: stopped, relays, policyHashesInUse: inUse };
};
