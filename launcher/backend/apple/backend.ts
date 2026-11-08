import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CommandRunner, errorMessage, LauncherError, type RunResult } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import {
  pruneCandidates,
  removeWithNetworkCleanup,
  repoNetworkLabels,
  repoNetworkName,
} from "../managed-network.ts";
import { missingImage, verifiedPull } from "../pull.ts";
import type {
  Backend,
  BackendCapabilities,
  ContainerSpec,
  Detection,
  ExecIo,
  ExecSpec,
  ImageInfo,
  NetworkRef,
  ProxyRoute,
  ProxyRouteRequest,
  RemoveContainerOptions,
} from "../types.ts";
import {
  APPLE_COMMANDS,
  APPLE_FLAGS,
  APPLE_SSH_SOCKET,
  type AppleNetwork,
  bindArgument,
  CONTAINER_CLI,
  containerSummariesOf,
  imageDigestOf,
  memoryArgument,
  mountedVolumesOf,
  networkNamesOf,
  networkOf,
  volumeArgument,
  volumesOf,
} from "./cli.ts";

type SpawnProcess = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface AppleOptions {
  runner: CommandRunner;
  spawn?: SpawnProcess;
}

const VOLUME_TARGET = "/volume";

const ARCHIVE_TARGET = "/archive";

const NOT_FOUND = /not found|does not exist|no such/i;

const ALREADY_EXISTS = /already exists/i;

const networkHint = (name: string) =>
  `remove it (container network delete ${name}) so the launcher can create its own`;

const capabilities: BackendCapabilities = {
  singleFileMount: false,
  sshAgent: true,
};

const firstLine = (result: RunResult) => (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";

const pairs = (flag: string, values: string[]) => values.flatMap((value) => [flag, value]);

const keyValues = (entries: Record<string, string>) =>
  Object.entries(entries).map(([key, value]) => `${key}=${value}`);

const optional = (flag: string, value: string | number | undefined) =>
  value === undefined ? [] : [flag, String(value)];

const networkArguments = (network: NetworkRef) =>
  network.kind === "none"
    ? [APPLE_FLAGS.network, "none"]
    : [APPLE_FLAGS.network, network.name, APPLE_FLAGS.noDns];

const guestEnv = (spec: ContainerSpec) =>
  spec.sshAgent === undefined ? spec.env : { ...spec.env, SSH_AUTH_SOCK: APPLE_SSH_SOCKET };

const mountArguments = (spec: ContainerSpec) =>
  spec.mounts.flatMap((mount) =>
    mount.kind === "bind"
      ? [APPLE_FLAGS.mount, bindArgument(mount)]
      : [APPLE_FLAGS.volume, volumeArgument(mount)],
  );

const PRIVATE_MODE = 0o600;

const envFileText = (env: Record<string, string>) =>
  keyValues(env)
    .map((line) => {
      if (/[\r\n]/.test(line)) {
        throw new LauncherError(
          `environment variable ${line.split("=")[0]} has a line break; it cannot be passed`,
        );
      }

      return `${line}\n`;
    })
    .join("");

const withEnvFile = async <T>(env: Record<string, string>, run: (flags: string[]) => Promise<T>) => {
  if (Object.keys(env).length === 0) {
    return run([]);
  }

  const text = envFileText(env);
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-env-"));
  const file = join(dir, "env");

  try {
    await writeFile(file, text, { mode: PRIVATE_MODE });

    return await run([APPLE_FLAGS.envFile, file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const createArguments = (spec: ContainerSpec, envFlags: string[]) => [
  ...APPLE_COMMANDS.create,
  APPLE_FLAGS.name,
  spec.name,
  ...pairs(APPLE_FLAGS.label, keyValues(spec.labels)),
  ...envFlags,
  ...mountArguments(spec),
  ...(spec.sshAgent === undefined ? [] : [APPLE_FLAGS.ssh]),
  ...networkArguments(spec.network),
  ...optional(APPLE_FLAGS.user, spec.user),
  ...pairs(APPLE_FLAGS.tmpfs, spec.tmpfs),
  ...(spec.readOnlyRoot ? [APPLE_FLAGS.readOnly] : []),
  ...(spec.init ? [APPLE_FLAGS.init] : []),
  APPLE_FLAGS.workdir,
  spec.workdir,
  ...optional(APPLE_FLAGS.cpus, spec.resources.cpus),
  ...optional(
    APPLE_FLAGS.memory,
    spec.resources.memoryGiB === undefined ? undefined : memoryArgument(spec.resources.memoryGiB),
  ),
  spec.image,
];

const execArguments = (spec: ExecSpec, io: ExecIo, envFlags: string[]) => [
  ...APPLE_COMMANDS.exec,
  ...(io.stdin === undefined ? [] : [APPLE_FLAGS.interactive]),
  ...(io.tty ? [APPLE_FLAGS.tty] : []),
  ...envFlags,
  APPLE_FLAGS.workdir,
  spec.workdir,
  spec.containerId,
  ...spec.command,
];

const pipedExec = (spawn: SpawnProcess, args: string[], io: ExecIo) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(CONTAINER_CLI, args, {
      stdio: [io.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    child.stdout?.pipe(io.stdout, { end: false });

    child.stderr?.pipe(io.stderr, { end: false });

    if (io.stdin !== undefined && child.stdin !== null) {
      io.stdin.pipe(child.stdin);
    }

    child.once("error", (error) => reject(new LauncherError(`${CONTAINER_CLI}: ${error.message}`)));

    child.once("close", (code) => {
      if (io.stdin !== undefined && child.stdin !== null) {
        io.stdin.unpipe(child.stdin);
      }

      resolve(code ?? 1);
    });
  });

export const createAppleBackend = (options: AppleOptions): Backend => {
  const { runner } = options;
  const spawn = options.spawn ?? spawnProcess;

  const container = (args: readonly string[]) => runner.run(CONTAINER_CLI, [...args]);

  const failure = (action: string, result: RunResult) =>
    new LauncherError(`container ${action}: ${firstLine(result)}`);

  const checked = async (action: string, args: readonly string[]) => {
    const result = await container(args);

    if (result.code !== 0) {
      throw failure(action, result);
    }

    return result;
  };

  const tolerant = async (action: string, args: readonly string[], tolerated: RegExp) => {
    const result = await container(args);

    if (result.code !== 0 && !tolerated.test(firstLine(result))) {
      throw failure(action, result);
    }
  };

  const detect = async (): Promise<Detection> => {
    try {
      const status = await container(APPLE_COMMANDS.systemStatus);

      if (status.code !== 0) {
        return {
          available: false,
          reason: `container system is not running (${firstLine(status)}), run container system start`,
        };
      }

      return { available: true, version: (await container(APPLE_COMMANDS.version)).stdout.trim() };
    } catch (error) {
      return { available: false, reason: errorMessage(error) };
    }
  };

  const inspectDigest = async (reference: string) => {
    const result = await container([...APPLE_COMMANDS.imageInspect, reference]);

    return result.code === 0 ? imageDigestOf(result.stdout) : undefined;
  };

  const resolveImage = async (reference: string) => {
    const digest = await inspectDigest(reference);

    return digest === undefined ? undefined : { id: reference, digest };
  };

  const pullImage = (reference: string, digest?: string): Promise<ImageInfo> =>
    verifiedPull(reference, digest, {
      inspect: inspectDigest,
      pull: (target) => checked("image pull", [...APPLE_COMMANDS.imagePull, target]),
      accepts: (found, expected) => found === expected,
      digestOf: (found) => found,
      infoOf: (found, target) => ({ id: target, digest: found }),
    });

  const buildImage = async (contextDir: string, tag: string, buildArgs: Record<string, string> = {}) => {
    await checked("build", [
      ...APPLE_COMMANDS.build,
      ...pairs(APPLE_FLAGS.buildArg, keyValues(buildArgs)),
      APPLE_FLAGS.tag,
      tag,
      APPLE_FLAGS.file,
      `${contextDir}/Dockerfile`,
      contextDir,
    ]);

    const digest = await inspectDigest(tag);

    if (digest === undefined) {
      throw missingImage(tag, "build");
    }

    return { id: tag, digest };
  };

  const findContainers = async (labels: Record<string, string>) => {
    const listed = containerSummariesOf((await checked("list", APPLE_COMMANDS.list)).stdout);

    return listed.filter((summary) =>
      Object.entries(labels).every(([key, value]) => summary.labels[key] === value),
    );
  };

  const createContainer = async (spec: ContainerSpec) => {
    const result = await withEnvFile(guestEnv(spec), (envFlags) =>
      container(createArguments(spec, envFlags)),
    );

    if (result.code !== 0 && ALREADY_EXISTS.test(firstLine(result))) {
      throw new LauncherError(`container name ${spec.name} is already in use`, "run pi sandbox reset");
    }

    if (result.code !== 0) {
      throw failure("create", result);
    }

    return { id: result.stdout.trim().split("\n").at(-1) || spec.name };
  };

  const startContainer = async (id: string) => {
    await checked("start", [...APPLE_COMMANDS.start, id]);
  };

  const stopContainer = async (id: string, timeoutSeconds?: number) => {
    await tolerant(
      "stop",
      [...APPLE_COMMANDS.stop, ...optional(APPLE_FLAGS.time, timeoutSeconds), id],
      NOT_FOUND,
    );
  };

  const removeNetwork = async (name: string) => {
    const network = await inspectProxyNetwork(name);

    return network?.managed === true && (await container([...APPLE_COMMANDS.networkRemove, name])).code === 0;
  };

  const pruneNetworks = async (keepRepoHashes: string[]) => {
    const listed = networkNamesOf((await checked("network list", APPLE_COMMANDS.networkList)).stdout);
    const candidates = pruneCandidates(listed, keepRepoHashes);
    const removed = await candidates.reduce<Promise<boolean[]>>(
      async (previous, name) => [...(await previous), await removeNetwork(name)],
      Promise.resolve([]),
    );

    return candidates.filter((_name, index) => removed[index]);
  };

  const repoHashOf = async (id: string) => {
    const inspected = await container([...APPLE_COMMANDS.inspect, id]);

    return inspected.code === 0
      ? containerSummariesOf(inspected.stdout)[0]?.labels[LABELS.repoHash]
      : undefined;
  };

  const deleteContainer = async (id: string) => {
    await tolerant("delete", [...APPLE_COMMANDS.remove, APPLE_FLAGS.force, id], NOT_FOUND);
  };

  const removeContainer = (id: string, options: RemoveContainerOptions = {}) =>
    removeWithNetworkCleanup(
      { repoHashOf, remove: deleteContainer, findContainers, removeNetwork },
      id,
      options,
    );

  const exec = (spec: ExecSpec, io: ExecIo) =>
    withEnvFile(spec.env, (envFlags) =>
      io.tty
        ? runner.spawnInteractive(CONTAINER_CLI, execArguments(spec, io, envFlags))
        : pipedExec(spawn, execArguments(spec, io, envFlags), io),
    );

  const ensureVolume = async (name: string, labels: Record<string, string> = {}) => {
    const present = await container([...APPLE_COMMANDS.volumeInspect, name]);

    if (present.code !== 0) {
      await checked("volume create", [
        ...APPLE_COMMANDS.volumeCreate,
        ...pairs(APPLE_FLAGS.label, keyValues({ ...labels, [LABELS.managed]: "true" })),
        name,
      ]);
    }
  };

  const listVolumes = async () => {
    const volumes = volumesOf((await checked("volume list", APPLE_COMMANDS.volumeList)).stdout);
    const mounted = mountedVolumesOf((await checked("list", APPLE_COMMANDS.list)).stdout);

    return volumes
      .filter((volume) => volume.labels[LABELS.managed] === "true")
      .map((volume) => ({ ...volume, inUse: mounted.has(volume.name) }));
  };

  const removeVolume = async (name: string) => {
    await tolerant("volume delete", [...APPLE_COMMANDS.volumeRemove, name], NOT_FOUND);
  };

  const runHelper = async (
    action: string,
    name: string,
    tarPath: string,
    imageId: string,
    tarArguments: string[],
  ) => {
    await checked(action, [
      ...APPLE_COMMANDS.run,
      APPLE_FLAGS.removeOnExit,
      APPLE_FLAGS.user,
      "0:0",
      ...networkArguments({ kind: "none" }),
      APPLE_FLAGS.volume,
      `${name}:${VOLUME_TARGET}`,
      APPLE_FLAGS.mount,
      bindArgument({ kind: "bind", source: dirname(tarPath), target: ARCHIVE_TARGET, readOnly: false }),
      APPLE_FLAGS.entrypoint,
      "tar",
      imageId,
      ...tarArguments,
    ]);
  };

  const archiveInGuest = (tarPath: string) => `${ARCHIVE_TARGET}/${basename(tarPath)}`;

  const exportVolume = async (name: string, tarPath: string, imageId: string) => {
    const present = await container([...APPLE_COMMANDS.volumeInspect, name]);

    if (present.code !== 0) {
      throw new LauncherError(`volume ${name} does not exist`);
    }

    await runHelper("volume export", name, tarPath, imageId, [
      "-c",
      "-f",
      archiveInGuest(tarPath),
      "-C",
      "/",
      "volume",
    ]);
  };

  const importVolume = async (name: string, tarPath: string, imageId: string) => {
    await stat(tarPath).catch(() => {
      throw new LauncherError(`volume archive ${tarPath} does not exist`);
    });

    await ensureVolume(name);

    await runHelper("volume import", name, tarPath, imageId, [
      "-x",
      "-f",
      archiveInGuest(tarPath),
      "-C",
      "/",
    ]);
  };

  const inspectProxyNetwork = async (name: string) => {
    const inspected = await container([...APPLE_COMMANDS.networkInspect, name]);

    return inspected.code === 0 ? networkOf(inspected.stdout) : undefined;
  };

  const assertManagedNetwork = (name: string, network: AppleNetwork) => {
    if (network.internal === undefined) {
      throw new LauncherError(`container network ${name} cannot be verified as internal`, networkHint(name));
    }

    if (!network.internal) {
      throw new LauncherError(`container network ${name} exists but is not internal`, networkHint(name));
    }

    if (!network.managed) {
      throw new LauncherError(
        `container network ${name} exists but is not managed by pi-sandbox`,
        networkHint(name),
      );
    }
  };

  const createProxyNetwork = async (name: string, repoHash: string) => {
    await checked("network create", [
      ...APPLE_COMMANDS.networkCreate,
      APPLE_FLAGS.internal,
      ...pairs(APPLE_FLAGS.label, keyValues(repoNetworkLabels(repoHash))),
      name,
    ]);

    return inspectProxyNetwork(name);
  };

  const prepareProxyRoute = async ({ hostPort, repoHash }: ProxyRouteRequest): Promise<ProxyRoute> => {
    const name = repoNetworkName(repoHash);
    const network = (await inspectProxyNetwork(name)) ?? (await createProxyNetwork(name, repoHash));

    if (network === undefined) {
      throw new LauncherError(`container network ${name} could not be inspected`);
    }

    assertManagedNetwork(name, network);

    if (network.gateway === undefined) {
      throw new LauncherError(`container network ${name} has no gateway address`);
    }

    return {
      network: { kind: "internal", name },
      address: `${network.gateway}:${hostPort}`,
    };
  };

  const status = async () => {
    const detection = await detect();

    return {
      runtime: detection.available ? "running" : `unavailable: ${detection.reason}`,
      version: detection.version ?? "unknown",
    };
  };

  return {
    name: "apple",
    capabilities,
    detect,
    pullImage,
    resolveImage,
    buildImage,
    findContainers,
    createContainer,
    startContainer,
    stopContainer,
    removeContainer,
    exec,
    ensureVolume,
    listVolumes,
    removeVolume,
    exportVolume,
    importVolume,
    prepareProxyRoute,
    pruneNetworks,
    proxyListenHosts: async () => [],
    status,
  };
};
