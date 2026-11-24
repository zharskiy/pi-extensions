import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type Backend,
  type ContainerSummary,
  execCapture,
  isSession,
  LABELS,
  type MountSpec,
} from "../backend/index.ts";
import { errorMessage, GUEST_PATHS, isWithin, LauncherError, recordCreatedDirs } from "../shared/index.ts";
import type { LauncherContainerSpec } from "./spec.ts";

export interface LaunchContainerInput {
  backend: Backend;
  stateDir: string;
  spec: LauncherContainerSpec;
  afterCreate?: (id: string) => Promise<void>;
  pinnedImage?: boolean;
}

export interface LaunchContainer {
  id: string;
  spec: LauncherContainerSpec;
  notices: string[];
}

const STOP_SECONDS = 3;

export const discardContainer = async (
  backend: Backend,
  container: ContainerSummary,
  seconds = STOP_SECONDS,
) => {
  if (container.state === "running") {
    await backend.stopContainer(container.id, seconds).catch(() => undefined);
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

const MOUNT_POINT_HINT = "replace it with a directory, or remove it so pinata can create one";

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
  const guard = { onMade, guarded: await Promise.all(spec.guardedPaths.map(realOrSelf)) };
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

const ROOT_SHELL = "/bin/sh";

const LOADER_AND_LIBC_VARIABLES = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "GCONV_PATH",
  "GETCONF_DIR",
  "HOSTALIASES",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "LD_ORIGIN_PATH",
  "LD_PROFILE",
  "LOCALDOMAIN",
  "LOCPATH",
  "MALLOC_TRACE",
  "NIS_PATH",
  "NLSPATH",
  "RESOLV_HOST_CONF",
  "RES_OPTIONS",
  "TMPDIR",
  "TZDIR",
  "GLIBC_TUNABLES",
  "LD_HWCAP_MASK",
];

export const ROOT_EXEC_ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ...Object.fromEntries(LOADER_AND_LIBC_VARIABLES.map((name) => [name, ""])),
};

const handoverScript = (owner: string) => `/bin/chown -h ${owner} "$@"`;

const HANDOVER_SCRIPT = `${handoverScript(DEFAULT_OWNER)} && : > ${GUEST_PATHS.handover}`;

export const chownRoots = (backend: Backend, id: string, owner: string, paths: string[]) =>
  execCapture(backend, {
    containerId: id,
    command: [ROOT_SHELL, "-c", handoverScript(owner), "sh", ...paths],
    env: ROOT_EXEC_ENV,
    workdir: "/",
    user: ROOT_USER,
  });

const READY_TRIES = 600;

const READY_TIMED_OUT = 3;

const FORWARD_FAILED = 4;

const READY_SCRIPT = [
  `grep -qF ${GUEST_PATHS.ready} ${GUEST_PATHS.entrypoint} 2>/dev/null || exit 0`,
  "tries=0",
  `while [ ! -e ${GUEST_PATHS.ready} ]; do`,
  `  [ "$tries" -lt ${READY_TRIES} ] || exit ${READY_TIMED_OUT}`,
  "  tries=$((tries + 1))",
  "  sleep 0.1",
  "done",
  `[ ! -s ${GUEST_PATHS.forwardStatus} ] || { cat ${GUEST_PATHS.forwardStatus} >&2; exit ${FORWARD_FAILED}; }`,
].join("\n");

const READY_EXEC_TIMEOUT_MS = (READY_TRIES / 10 + 30) * 1000;

const HANDOVER_HINT = "run pinata doctor, and check the targets in mounts.volumes";

const STARTUP_HINT = "run pinata doctor";

const PINNED_IMAGE_HINT = "the image is pinned by image.digest and may predate this pinata version";

const handOverVolumes = async (backend: Backend, id: string, spec: LauncherContainerSpec) => {
  if (spec.ownedPaths.length === 0) {
    return;
  }

  const result = await execCapture(backend, {
    containerId: id,
    command: [ROOT_SHELL, "-c", HANDOVER_SCRIPT, "sh", ...spec.ownedPaths],
    env: ROOT_EXEC_ENV,
    workdir: "/",
    user: ROOT_USER,
  });

  if (result.code !== 0) {
    throw new LauncherError(
      `the sandbox could not hand its volumes to the sandbox user: ${result.stderr.trim()}`,
      HANDOVER_HINT,
    );
  }
};

const awaitEntrypoint = async (backend: Backend, id: string) => {
  const result = await execCapture(
    backend,
    { containerId: id, command: ["sh", "-c", READY_SCRIPT], env: {}, workdir: "/" },
    "",
    READY_EXEC_TIMEOUT_MS,
  );

  if (result.code === READY_TIMED_OUT) {
    throw new LauncherError(
      `the sandbox entrypoint did not finish preparing the home within ${READY_TRIES / 10} s (no ${GUEST_PATHS.ready})`,
      STARTUP_HINT,
    );
  }

  if (result.code === FORWARD_FAILED) {
    throw new LauncherError(
      `the sandbox could not forward the services' ports: ${result.stderr.trim()}`,
      "free that port in the sandbox, or change services[].ports in the config",
    );
  }

  if (result.code !== 0) {
    throw new LauncherError(
      `the check that the sandbox entrypoint finished failed (exit ${result.code}): ${result.stderr.trim()}`,
      STARTUP_HINT,
    );
  }
};

const isStillRunning = (backend: Backend, id: string) =>
  backend.inspectContainer(id).then(
    (container) => container?.state === "running",
    () => true,
  );

const startupHint = (error: unknown, pinnedImage: boolean) => {
  const hint = error instanceof LauncherError && error.hint !== undefined ? error.hint : STARTUP_HINT;

  return pinnedImage ? `${hint}; ${PINNED_IMAGE_HINT}` : hint;
};

const settleStartup = async (input: LaunchContainerInput, id: string, spec: LauncherContainerSpec) => {
  try {
    await handOverVolumes(input.backend, id, spec);

    await awaitEntrypoint(input.backend, id);

    await input.afterCreate?.(id);
  } catch (error) {
    if (await isStillRunning(input.backend, id)) {
      throw error;
    }

    throw new LauncherError(
      `the sandbox container exited during startup, before pi could run (${errorMessage(error)})`,
      startupHint(error, input.pinnedImage === true),
    );
  }
};

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

export const startLaunchContainer = async (input: LaunchContainerInput): Promise<LaunchContainer> => {
  const { backend, spec } = input;
  const { mounts } = spec;

  await pruneCacheVolumes(backend, spec);

  await Promise.all(
    mounts
      .filter((mount) => mount.kind === "volume")
      .map((mount) => backend.ensureVolume(mount.source, spec.volumeLabels[mount.source])),
  );

  await ensureMountPoints(spec, (path) => recordCreatedDirs(input.stateDir, specRepoHash(spec), [path]));

  const { id } = await backend.createContainer(runtimeSpec(spec));

  await backend.startContainer(id);

  await settleStartup(input, id, spec);

  return { id, spec, notices: spec.notices };
};

export const removeLaunchContainer = async (backend: Backend, launchId: string) => {
  const sessions = (await backend.findContainers({ [LABELS.launchId]: launchId })).filter((container) =>
    isSession(container.labels),
  );

  await Promise.all(sessions.map((container) => discardContainer(backend, container)));

  return sessions;
};

export const listLauncherContainers = (backend: Backend) => backend.findContainers({});
