import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { type Backend, type ContainerSummary, execCapture, type MountSpec } from "../backend/index.ts";
import {
  errorMessage,
  isWithin,
  LauncherError,
  readJsonFile,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { LABELS, repoHash, wantedFile } from "./names.ts";
import type { LauncherContainerSpec } from "./spec.ts";

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

const recordWanted = (spec: LauncherContainerSpec) =>
  writeJsonFile(
    spec.wantedFile,
    Object.fromEntries(IDENTITY.map((label) => [label, spec.labels[label] ?? ""])),
  );

export const isCurrentContainer = async (
  container: ContainerSummary,
  input: { stateDir: string; repoRoot: string; digest: string; configHash: string },
) => {
  const wanted = await readJsonFile<Record<string, string>>(wantedFile(input.stateDir, input.repoRoot));

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

const runtimeSpec = ({
  wantedFile: _wanted,
  volumeLabels: _labels,
  ownedPaths: _owned,
  ...spec
}: LauncherContainerSpec) => spec;

const DEFAULT_OWNER = "1000:1000";

const ROOT_USER = "0";

const MOUNT_POINT_HINT = "replace it with a directory, or remove it so the launcher can create one";

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const isTaken = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

const foundAt = (path: string) =>
  lstat(path).catch((error: unknown) => (isMissing(error) ? undefined : Promise.reject(error)));

const ensureMountPoint = async (root: string, path: string): Promise<void> => {
  const found = await foundAt(path);

  if (found?.isSymbolicLink() === true) {
    throw new LauncherError(`the mount point ${path} is a symbolic link`, MOUNT_POINT_HINT);
  }

  if (found !== undefined && !found.isDirectory()) {
    throw new LauncherError(`the mount point ${path} is not a directory`, MOUNT_POINT_HINT);
  }

  if (found !== undefined && !isWithin(await realpath(path), await realpath(root))) {
    throw new LauncherError(`the mount point ${path} leads outside ${root}`, MOUNT_POINT_HINT);
  }

  if (found !== undefined || path === root) {
    return;
  }

  await ensureMountPoint(root, dirname(path));

  await mkdir(path).catch((error: unknown) =>
    isTaken(error) ? ensureMountPoint(root, path) : Promise.reject(error),
  );
};

const writableRootOf = (mounts: MountSpec[], target: string) =>
  mounts.find(
    (mount) =>
      mount.kind === "bind" &&
      !mount.readOnly &&
      mount.source === mount.target &&
      mount.target !== target &&
      isWithin(target, mount.target),
  )?.target;

const ensureMountPoints = (mounts: MountSpec[]) =>
  Promise.all(
    mounts
      .filter((mount) => mount.kind === "volume")
      .flatMap((mount) => {
        const root = writableRootOf(mounts, mount.target);

        return root === undefined ? [] : [ensureMountPoint(root, mount.target)];
      }),
  );

const handOverVolumes = async (backend: Backend, id: string, spec: LauncherContainerSpec) => {
  if (spec.ownedPaths.length === 0) {
    return [];
  }

  const result = await execCapture(backend, {
    containerId: id,
    command: ["chown", "-h", DEFAULT_OWNER, ...spec.ownedPaths],
    env: {},
    workdir: "/",
    user: ROOT_USER,
  }).catch((error: unknown) => ({ code: -1, stdout: "", stderr: errorMessage(error) }));

  return result.code === 0
    ? []
    : [`warning: the sandbox user may not be able to write its cache volumes: ${result.stderr.trim()}`];
};

const startPrepared = async (backend: Backend, id: string, spec: LauncherContainerSpec, current = true) => {
  if (!current) {
    await backend.startContainer(id);

    return [];
  }

  await ensureMountPoints(spec.mounts);

  await backend.startContainer(id);

  return handOverVolumes(backend, id, spec);
};

const ownerLabels = (labels: Record<string, string>) =>
  Object.fromEntries(
    [LABELS.repoHash, LABELS.repoRoot].flatMap((key) => {
      const value = labels[key];

      return value === undefined ? [] : [[key, value]];
    }),
  );

const createFresh = async (backend: Backend, spec: LauncherContainerSpec): Promise<EnsuredContainer> => {
  const { mounts } = spec;
  const owner = ownerLabels(spec.labels);

  await Promise.all(
    mounts
      .filter((mount) => mount.kind === "volume")
      .map((mount) => backend.ensureVolume(mount.source, spec.volumeLabels[mount.source] ?? owner)),
  );

  await ensureMountPoints(mounts);

  const { id } = await backend.createContainer(runtimeSpec(spec));
  const notices = await startPrepared(backend, id, spec);

  return { id, created: true, outdated: false, spec, notices };
};

const repoContainers = (backend: Backend, spec: LauncherContainerSpec) =>
  backend.findContainers({ [LABELS.repoHash]: spec.labels[LABELS.repoHash] ?? "" });

const reuse = async (
  backend: Backend,
  container: ContainerSummary,
  spec: LauncherContainerSpec,
): Promise<EnsuredContainer> => {
  const outdated = !isCurrent(container, spec.labels);
  const started =
    container.state === "running" ? [] : await startPrepared(backend, container.id, spec, !outdated);
  const guarded = spec.labels[LABELS.gitCommonDir] ?? spec.labels[LABELS.gitCommonDirs];
  const unprotected = guarded !== undefined && container.labels[LABELS.gitProtection] === undefined;

  return {
    id: container.id,
    created: false,
    outdated,
    spec,
    notices: [...(outdated ? [OUTDATED, ...(unprotected ? [UNPROTECTED] : [])] : []), ...started],
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
  withFileLock(`${input.spec.wantedFile}.lock`, () => findOrCreate(input), { timeoutMs: LOCK_TIMEOUT_MS });

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

const listedGitDirs = (label: string | undefined): string[] => {
  if (label === undefined) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(label);

    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

const gitDirsOf = (container: ContainerSummary) => {
  const single = container.labels[LABELS.gitCommonDir];

  return [
    ...(single === undefined ? [] : [single]),
    ...listedGitDirs(container.labels[LABELS.gitCommonDirs]),
  ];
};

const sharesGitDir = (container: ContainerSummary, gitCommonDir: string) =>
  gitDirsOf(container).some((other) => isWithin(other, gitCommonDir) || isWithin(gitCommonDir, other));

export const gitDirInUseElsewhere = async (
  backend: Backend,
  owner: Workspace,
  gitCommonDir: string | undefined = owner.gitCommonDir,
) => {
  if (gitCommonDir === undefined) {
    return false;
  }

  const own = repoHash(owner.repoRoot);

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
