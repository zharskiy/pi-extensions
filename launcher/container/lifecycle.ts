import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Backend, ContainerSummary, MountSpec } from "../backend/index.ts";
import { isWithin, readJsonFile, sha256Hex, withFileLock, writeJsonFile } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { copiesDir, LABELS, repoHash } from "./names.ts";
import type { LauncherContainerSpec, RequiredCopy } from "./spec.ts";

export interface EnsureContainerInput {
  backend: Backend;
  spec: LauncherContainerSpec;
  othersLive?: () => Promise<boolean>;
  beforeStart?: () => Promise<LauncherContainerSpec>;
  aroundStart?: <T>(start: () => Promise<T>) => Promise<T>;
}

export interface EnsuredContainer {
  id: string;
  created: boolean;
  outdated: boolean;
  spec: LauncherContainerSpec;
  notices: string[];
}

export interface Garbage {
  containers: ContainerSummary[];
  relays: ContainerSummary[];
  policyHashesInUse: string[];
}

const MANAGED = { [LABELS.managed]: "true" };

const RELAYS = { [LABELS.relay]: "true" };

const IDENTITY = [LABELS.imageDigest, LABELS.configHash, LABELS.specHash];

const LOCK_TIMEOUT_MS = 120_000;

const OUTDATED = "the sandbox config changed; it applies after every session in this repository exits";

const UNPROTECTED =
  "the running sandbox of this repository predates the read-only git dir snapshots; they apply after every session in this repository exits";

const isCurrent = (container: ContainerSummary, labels: Record<string, string | undefined>) =>
  IDENTITY.every((label) => container.labels[label] === labels[label]);

const wantedFileOf = (directory: string) => `${directory}.wanted.json`;

const recordWanted = (spec: LauncherContainerSpec) =>
  writeJsonFile(
    wantedFileOf(spec.copiesDir),
    Object.fromEntries(IDENTITY.map((label) => [label, spec.labels[label] ?? ""])),
  );

export const isCurrentContainer = async (
  container: ContainerSummary,
  input: { stateDir: string; repoRoot: string; digest: string; configHash: string },
) => {
  const wanted = await readJsonFile<Record<string, string>>(
    wantedFileOf(copiesDir(input.stateDir, input.repoRoot)),
  );

  return isCurrent(container, {
    [LABELS.imageDigest]: input.digest,
    [LABELS.configHash]: input.configHash,
    [LABELS.specHash]: wanted?.[LABELS.specHash],
  });
};

const discard = async (backend: Backend, container: ContainerSummary, keepNetwork = false) => {
  if (container.state === "running") {
    await backend.stopContainer(container.id);
  }

  await backend.removeContainer(container.id, { keepNetwork });
};

const placeCopyDir = async (
  guestDir: string,
  copies: RequiredCopy[],
  directory: string,
): Promise<MountSpec> => {
  const placed = join(directory, sha256Hex(guestDir).slice(0, 12));

  await mkdir(placed, { recursive: true });

  await Promise.all(copies.map((copy) => copyFile(copy.source, join(placed, basename(copy.target)))));

  return { source: placed, target: guestDir, readOnly: true, kind: "bind" };
};

const shadowsMount = (guestDir: string, mounts: MountSpec[]) =>
  mounts.some((mount) => isWithin(guestDir, mount.target));

const placeCopies = async (spec: LauncherContainerSpec) => {
  const placeable = spec.requiredCopies.filter((copy) => !shadowsMount(dirname(copy.target), spec.mounts));

  if (placeable.length === 0) {
    return [];
  }

  await mkdir(spec.copiesDir, { recursive: true });

  const guestDirs = [...new Set(placeable.map((copy) => dirname(copy.target)))];

  return Promise.all(
    guestDirs.map((guestDir) =>
      placeCopyDir(
        guestDir,
        placeable.filter((copy) => dirname(copy.target) === guestDir),
        spec.copiesDir,
      ),
    ),
  );
};

const runtimeSpec = ({ requiredCopies: _copies, copiesDir: _dir, ...spec }: LauncherContainerSpec) => spec;

const createFresh = async (backend: Backend, spec: LauncherContainerSpec): Promise<EnsuredContainer> => {
  const copied = await placeCopies(spec);
  const mounts = [...spec.mounts, ...copied];

  await Promise.all(
    mounts.filter((mount) => mount.kind === "volume").map((mount) => backend.ensureVolume(mount.source)),
  );

  const { id } = await backend.createContainer({ ...runtimeSpec(spec), mounts });

  await backend.startContainer(id);

  return { id, created: true, outdated: false, spec, notices: [] };
};

const repoContainers = (backend: Backend, spec: LauncherContainerSpec) =>
  backend.findContainers({ [LABELS.repoHash]: spec.labels[LABELS.repoHash] ?? "" });

const reuse = async (
  backend: Backend,
  container: ContainerSummary,
  spec: LauncherContainerSpec,
): Promise<EnsuredContainer> => {
  if (container.state !== "running") {
    await backend.startContainer(container.id);
  }

  const outdated = !isCurrent(container, spec.labels);
  const unprotected =
    spec.labels[LABELS.gitCommonDir] !== undefined && container.labels[LABELS.gitProtection] === undefined;

  return {
    id: container.id,
    created: false,
    outdated,
    spec,
    notices: outdated ? [OUTDATED, ...(unprotected ? [UNPROTECTED] : [])] : [],
  };
};

const createOrAdopt = async (backend: Backend, spec: LauncherContainerSpec) => {
  try {
    return await createFresh(backend, spec);
  } catch (error) {
    const raced = (await repoContainers(backend, spec)).find((container) => container.name === spec.name);

    if (raced === undefined) {
      throw error;
    }

    return reuse(backend, raced, spec);
  }
};

const startOrCreateNow = async (input: EnsureContainerInput, stopped: ContainerSummary | undefined) => {
  const { backend } = input;
  const spec = (await input.beforeStart?.()) ?? input.spec;

  await recordWanted(spec);

  if (stopped !== undefined && isCurrent(stopped, spec.labels)) {
    await placeCopies(spec);

    return reuse(backend, stopped, spec);
  }

  if (stopped !== undefined) {
    await discard(backend, stopped, true);
  }

  return createOrAdopt(backend, spec);
};

const startOrCreate = (input: EnsureContainerInput, stopped: ContainerSummary | undefined) => {
  const start = () => startOrCreateNow(input, stopped);

  return input.aroundStart === undefined ? start() : input.aroundStart(start);
};

const findOrCreate = async (input: EnsureContainerInput): Promise<EnsuredContainer> => {
  const { backend, spec } = input;

  await recordWanted(spec);

  const existing = await repoContainers(backend, spec);
  const current = existing.find((container) => isCurrent(container, spec.labels));

  if (current?.state === "running") {
    await placeCopies(spec);

    return reuse(backend, current, spec);
  }

  const shared = existing.find((container) => container.state === "running");

  if (shared !== undefined && (await input.othersLive?.()) === true) {
    return reuse(backend, shared, spec);
  }

  await Promise.all(
    existing
      .filter((container) => container !== current)
      .map((container) => discard(backend, container, true)),
  );

  return startOrCreate(input, current);
};

export const ensureContainer = (input: EnsureContainerInput) =>
  withFileLock(`${input.spec.copiesDir}.lock`, () => findOrCreate(input), { timeoutMs: LOCK_TIMEOUT_MS });

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

const sharesGitDir = (container: ContainerSummary, gitCommonDir: string) => {
  const other = container.labels[LABELS.gitCommonDir];

  return other !== undefined && (isWithin(other, gitCommonDir) || isWithin(gitCommonDir, other));
};

export const gitDirInUseElsewhere = async (backend: Backend, workspace: Workspace) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return false;
  }

  const own = repoHash(workspace.repoRoot);

  return (await listLauncherContainers(backend)).some(
    (container) =>
      container.state !== "stopped" &&
      container.labels[LABELS.repoHash] !== own &&
      sharesGitDir(container, gitCommonDir),
  );
};

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

export interface GarbageKeep {
  repoHashes: string[];
  policyHashes: string[];
}

export const collectGarbage = async (
  backend: Backend,
  keep: GarbageKeep = { repoHashes: [], policyHashes: [] },
): Promise<Garbage> => {
  const agents = await listLauncherContainers(backend);
  const stopped = agents.filter(
    (container) =>
      container.state !== "running" && !keep.repoHashes.includes(container.labels[LABELS.repoHash] ?? ""),
  );
  const inUse = [...new Set([...runningPolicyHashes(agents), ...keep.policyHashes])];

  await Promise.all(stopped.map((container) => backend.removeContainer(container.id)));

  const relays = (await backend.findContainers(RELAYS)).filter(
    (relay) => !inUse.includes(relay.labels[LABELS.proxyPolicyHash] ?? ""),
  );

  await Promise.all(relays.map((relay) => discard(backend, relay)));

  return { containers: stopped, relays, policyHashesInUse: inUse };
};
