import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type Backend,
  type ContainerSummary,
  execCapture,
  LABELS,
  type MountSpec,
} from "../backend/index.ts";
import {
  errorMessage,
  isWithin,
  LauncherError,
  recordCreatedDirs,
  stateLayout,
  withFileLock,
} from "../shared/index.ts";
import type { LauncherContainerSpec } from "./spec.ts";

export interface LaunchContainerInput {
  backend: Backend;
  spec: LauncherContainerSpec;
  stateDir: string;
  beforeStart?: () => Promise<LauncherContainerSpec>;
  afterCreate?: (id: string) => Promise<void>;
}

export interface LaunchContainer {
  id: string;
  spec: LauncherContainerSpec;
  notices: string[];
}

const MANAGED = { [LABELS.managed]: "true" };

const LOCK_TIMEOUT_MS = 120_000;

const STOP_SECONDS = 3;

export const discardContainer = async (backend: Backend, container: ContainerSummary) => {
  if (container.state === "running") {
    await backend.stopContainer(container.id, STOP_SECONDS).catch(() => undefined);
  }

  await backend.removeContainer(container.id);
};

const runtimeSpec = ({
  volumeLabels: _labels,
  ownedPaths: _owned,
  guardedPaths: _guarded,
  notices: _notices,
  ...spec
}: LauncherContainerSpec) => spec;

const DEFAULT_OWNER = "1000:1000";

const ROOT_USER = "0";

const MOUNT_POINT_HINT = "replace it with a directory, or remove it so the launcher can create one";

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const isTaken = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

const foundAt = (path: string) =>
  lstat(path).catch((error: unknown) => (isMissing(error) ? undefined : Promise.reject(error)));

type DirMade = (path: string) => Promise<void>;

interface MountPointGuard {
  onMade: DirMade;
  guarded: string[];
}

const PROTECTED_HINT = "choose a path outside the git dirs and the read-only mounts";

const realOrSelf = (path: string) => realpath(path).catch(() => path);

const realTarget = async (path: string, exists: boolean) =>
  exists ? realpath(path) : join(await realpath(dirname(path)), basename(path));

const assertUnguarded = async (path: string, exists: boolean, guarded: string[]) => {
  const real = await realTarget(path, exists);
  const inside = guarded.find((target) => isWithin(real, target));

  if (inside !== undefined) {
    throw new LauncherError(
      `the mount point ${path} lies inside ${inside}, which the sandbox protects`,
      PROTECTED_HINT,
    );
  }
};

const ensureMountPoint = async (root: string, path: string, guard: MountPointGuard): Promise<void> => {
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

  if (path === root) {
    return;
  }

  if (found !== undefined) {
    await assertUnguarded(path, true, guard.guarded);

    return;
  }

  await ensureMountPoint(root, dirname(path), guard);

  await assertUnguarded(path, false, guard.guarded);

  await mkdir(path).then(
    () => guard.onMade(path),
    (error: unknown) => (isTaken(error) ? ensureMountPoint(root, path, guard) : Promise.reject(error)),
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

const ensureMountPoints = async (spec: LauncherContainerSpec, onMade: DirMade) => {
  const { mounts } = spec;
  const guard = { onMade, guarded: await Promise.all((spec.guardedPaths ?? []).map(realOrSelf)) };
  const outcomes = await Promise.allSettled(
    mounts
      .filter((mount) => mount.kind === "volume")
      .flatMap((mount) => {
        const root = writableRootOf(mounts, mount.target);

        return root === undefined ? [] : [ensureMountPoint(root, mount.target, guard)];
      }),
  );
  const failed = outcomes.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    throw failed.reason;
  }
};

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

const ownerLabels = (labels: Record<string, string>) =>
  Object.fromEntries(
    [LABELS.repoHash, LABELS.repoRoot].flatMap((key) => {
      const value = labels[key];

      return value === undefined ? [] : [[key, value]];
    }),
  );

const specRepoHash = (spec: LauncherContainerSpec) => spec.labels[LABELS.repoHash] ?? "";

const pruneCacheVolumes = async (backend: Backend, spec: LauncherContainerSpec) => {
  const mounted = new Set(
    spec.mounts.filter((mount) => mount.kind === "volume").map((mount) => mount.source),
  );
  const stale = (await backend.listVolumes()).filter(
    (volume) =>
      volume.labels[LABELS.repoHash] === specRepoHash(spec) &&
      volume.labels[LABELS.cachePath] !== undefined &&
      !volume.inUse &&
      !mounted.has(volume.name),
  );

  await Promise.all(stale.map((volume) => backend.removeVolume(volume.name).catch(() => undefined)));
};

const create = async (input: LaunchContainerInput, spec: LauncherContainerSpec): Promise<LaunchContainer> => {
  const { backend } = input;
  const { mounts } = spec;
  const owner = ownerLabels(spec.labels);

  await pruneCacheVolumes(backend, spec);

  await Promise.all(
    mounts
      .filter((mount) => mount.kind === "volume")
      .map((mount) => backend.ensureVolume(mount.source, spec.volumeLabels[mount.source] ?? owner)),
  );

  await ensureMountPoints(spec, (path) => recordCreatedDirs(input.stateDir, specRepoHash(spec), [path]));

  const { id } = await backend.createContainer(runtimeSpec(spec));

  await backend.startContainer(id);

  const notices = [...(spec.notices ?? []), ...(await handOverVolumes(backend, id, spec))];

  await input.afterCreate?.(id);

  return { id, spec, notices };
};

const isAgent = (container: ContainerSummary) => container.labels[LABELS.relay] !== "true";

const agentContainers = async (backend: Backend, labels: Record<string, string>) =>
  (await backend.findContainers(labels)).filter(isAgent);

export const startLaunchContainer = (input: LaunchContainerInput) =>
  withFileLock(
    stateLayout(input.stateDir).repo(specRepoHash(input.spec)).containerLock,
    async () => create(input, (await input.beforeStart?.()) ?? input.spec),
    { timeoutMs: LOCK_TIMEOUT_MS },
  );

const discardAll = async (backend: Backend, labels: Record<string, string>) => {
  const existing = await agentContainers(backend, labels);

  await Promise.all(existing.map((container) => discardContainer(backend, container)));

  return existing;
};

export const removeLaunchContainer = (backend: Backend, launchId: string) =>
  discardAll(backend, { [LABELS.launchId]: launchId });

export const listLauncherContainers = async (backend: Backend) =>
  (await backend.findContainers(MANAGED)).filter(isAgent);

export const removeRepoContainers = (backend: Backend, repo: string) =>
  discardAll(backend, { [LABELS.repoHash]: repo });
