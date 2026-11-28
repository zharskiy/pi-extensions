import { type Backend, type ContainerSummary, execCapture, isSession, LABELS } from "../backend/index.ts";
import { errorMessage, GUEST_PATHS, LauncherError } from "../shared/index.ts";
import type { LauncherContainerSpec } from "./spec.ts";

export interface LaunchContainerInput {
  backend: Backend;
  spec: LauncherContainerSpec;
  afterCreate?: (id: string) => Promise<void>;
  pinnedImage?: boolean;
}

export interface LaunchContainer {
  id: string;
  spec: LauncherContainerSpec;
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

const runtimeSpec = ({ ownedPaths: _owned, ...spec }: LauncherContainerSpec) => spec;

const DEFAULT_OWNER = "1000:1000";

const ROOT_USER = "0";

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

const PINNED_IMAGE_HINT = "the image is pinned by image.reference and may predate this pinata version";

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

export const startLaunchContainer = async (input: LaunchContainerInput): Promise<LaunchContainer> => {
  const { backend, spec } = input;
  const { mounts } = spec;

  await Promise.all(
    mounts.filter((mount) => mount.kind === "volume").map((mount) => backend.ensureVolume(mount.source)),
  );

  const { id } = await backend.createContainer(runtimeSpec(spec));

  await backend.startContainer(id);

  await settleStartup(input, id, spec);

  return { id, spec };
};

export const removeLaunchContainer = async (backend: Backend, launchId: string) => {
  const sessions = (await backend.findContainers({ [LABELS.launchId]: launchId })).filter((container) =>
    isSession(container.labels),
  );

  await Promise.all(sessions.map((container) => discardContainer(backend, container)));

  return sessions;
};

export const listLauncherContainers = (backend: Backend) => backend.findContainers({});
