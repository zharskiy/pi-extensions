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
  repoHash,
  stateLayout,
  withFileLock,
} from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import type { LauncherContainerSpec } from "./spec.ts";

export interface EnsureContainerInput {
  backend: Backend;
  spec: LauncherContainerSpec;
  stateDir: string;
  othersLive?: () => Promise<boolean>;
  beforeStart?: () => Promise<LauncherContainerSpec>;
  aroundStart?: <T>(start: () => Promise<T>) => Promise<T>;
  afterCreate?: (id: string) => Promise<void>;
}

export interface EnsuredContainer {
  id: string;
  created: boolean;
  outdated: boolean;
  spec: LauncherContainerSpec;
  notices: string[];
}

const MANAGED = { [LABELS.managed]: "true" };

const IDENTITY = [LABELS.imageDigest, LABELS.specHash, LABELS.proxyTokenHash];

const LOCK_TIMEOUT_MS = 120_000;

const STOP_SECONDS = 3;

const REMOVAL_WAIT_MS = 10_000;

const APPLIES_LATER = "it applies after every session in this repository exits";

const sectionsOf = (labels: Record<string, string | undefined>) => {
  try {
    const parsed: unknown = JSON.parse(labels[LABELS.specSections] ?? "");

    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const outdatedNotice = (container: ContainerSummary, spec: LauncherContainerSpec) => {
  const running = sectionsOf(container.labels);
  const wanted = sectionsOf(spec.labels) ?? {};
  const changed = Object.keys(wanted).filter((name) => running?.[name] !== wanted[name]);

  return running === undefined || changed.length === 0
    ? `the sandbox config changed; ${APPLIES_LATER}`
    : `the sandbox config changed (${changed.join(", ")}); ${APPLIES_LATER}`;
};

const isCurrent = (container: ContainerSummary, labels: Record<string, string | undefined>) =>
  IDENTITY.every((label) => container.labels[label] === labels[label]);

export const discardContainer = async (backend: Backend, container: ContainerSummary) => {
  if (container.state === "running") {
    await backend.stopContainer(container.id, STOP_SECONDS).catch(() => undefined);
  }

  await backend.removeContainer(container.id);

  await backend.waitRemoved(container.id, REMOVAL_WAIT_MS);
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

const createFresh = async (
  input: EnsureContainerInput,
  spec: LauncherContainerSpec,
): Promise<EnsuredContainer> => {
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

  return {
    id,
    created: true,
    outdated: false,
    spec,
    notices: [...(spec.notices ?? []), ...(await handOverVolumes(backend, id, spec))],
  };
};

const isAgent = (container: ContainerSummary) => container.labels[LABELS.relay] !== "true";

const agentContainers = async (backend: Backend, repo: string) =>
  (await backend.findContainers({ [LABELS.repoHash]: repo })).filter(isAgent);

const reuse = (container: ContainerSummary, spec: LauncherContainerSpec): EnsuredContainer => {
  const outdated = !isCurrent(container, spec.labels);

  return {
    id: container.id,
    created: false,
    outdated,
    spec,
    notices: [...(spec.notices ?? []), ...(outdated ? [outdatedNotice(container, spec)] : [])],
  };
};

const createOrAdopt = async (input: EnsureContainerInput, spec: LauncherContainerSpec) => {
  try {
    return await createFresh(input, spec);
  } catch (error) {
    const raced = (await agentContainers(input.backend, specRepoHash(spec))).find(
      (container) => container.name === spec.name && container.state === "running",
    );

    if (raced === undefined) {
      throw error;
    }

    return reuse(raced, spec);
  }
};

const createNow = async (input: EnsureContainerInput) =>
  createOrAdopt(input, (await input.beforeStart?.()) ?? input.spec);

const create = (input: EnsureContainerInput) =>
  input.aroundStart === undefined ? createNow(input) : input.aroundStart(() => createNow(input));

const checked = async (input: EnsureContainerInput, ensured: EnsuredContainer) => {
  if (!ensured.created || input.afterCreate === undefined) {
    return ensured;
  }

  await input.afterCreate(ensured.id).catch(async (error: unknown) => {
    const made = (await agentContainers(input.backend, specRepoHash(ensured.spec))).find(
      (container) => container.id === ensured.id,
    );

    if (made !== undefined) {
      await discardContainer(input.backend, made);
    }

    throw error;
  });

  return ensured;
};

const findOrCreate = async (input: EnsureContainerInput): Promise<EnsuredContainer> => {
  const { backend, spec } = input;
  const existing = await agentContainers(backend, specRepoHash(spec));
  const running = existing.filter((container) => container.state === "running");
  const current = running.find((container) => isCurrent(container, spec.labels));

  if (current !== undefined) {
    return reuse(current, spec);
  }

  const [shared] = running;

  if (shared !== undefined && (await input.othersLive?.()) === true) {
    return reuse(shared, spec);
  }

  await Promise.all(existing.map((container) => discardContainer(backend, container)));

  return checked(input, await create(input));
};

export const ensureContainer = (input: EnsureContainerInput) =>
  withFileLock(
    stateLayout(input.stateDir).repo(specRepoHash(input.spec)).containerLock,
    () => findOrCreate(input),
    { timeoutMs: LOCK_TIMEOUT_MS },
  );

export const findCurrentContainer = async (backend: Backend, workspace: Workspace, digest: string) => {
  const [found] = await backend.findContainers({
    [LABELS.repoHash]: repoHash(workspace.repoRoot),
    [LABELS.imageDigest]: digest,
  });

  return found;
};

export const findRepoContainer = async (backend: Backend, workspace: Workspace) => {
  const [found] = await agentContainers(backend, repoHash(workspace.repoRoot));

  return found;
};

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

export const gitDirInUseElsewhere = async (backend: Backend, owner: string, gitCommonDir: string) =>
  (await listLauncherContainers(backend)).some(
    (container) =>
      container.state !== "stopped" &&
      container.labels[LABELS.repoHash] !== owner &&
      sharesGitDir(container, gitCommonDir),
  );

export const removeRepoContainers = async (backend: Backend, repo: string) => {
  const existing = await agentContainers(backend, repo);

  await Promise.all(existing.map((container) => discardContainer(backend, container)));

  return existing;
};
