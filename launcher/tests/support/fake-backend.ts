import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  Backend,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  ExecIo,
  ExecSpec,
  ImageInfo,
  ImageSummary,
  TerminalSize,
  Vm,
} from "../../backend/index.ts";
import { isOlderBuild, LABELS, networkName, relayName } from "../../backend/index.ts";
import { GUEST_PATHS, LauncherError } from "../../shared/index.ts";
import { fakeUidOf, isFakeScript, runFakeScript } from "./fake-engine.ts";

interface FakeContainer {
  summary: ContainerSummary;
  spec?: ContainerSpec;
  logs?: string[];
  exitCode?: number;
}

interface FakeBuild {
  contextDir: string;
  tag: string;
  args?: Record<string, string>;
  offline?: boolean;
  files: Record<string, string>;
}

export interface FakeExec {
  spec: ExecSpec;
  tty: boolean;
  size?: TerminalSize;
  resizes: TerminalSize[];
  stdin: Buffer[];
}

export interface FakeExecScript {
  command: string[];
  code?: number;
  stdout?: string;
  stderr?: string;
}

interface FakeRoute {
  hostPort: number;
  imageId: string;
  preamble: string;
}

interface FakeRelay {
  id: string;
  install: string;
  hostPort: number;
  imageId: string;
  preamble: string;
  network: string;
}

interface FakeBackendOptions {
  localImages?: Record<string, string>;
  registry?: Record<string, string>;
  exec?: (spec: ExecSpec, io: ExecIo) => Promise<number | undefined> | number | undefined;
  execScripts?: FakeExecScript[];
  guestAgentDir?: string;
  vm?: Partial<Vm>;
}

export const FAKE_INSTALL = "fakeinstall0";

export const FAKE_NETWORK = networkName(FAKE_INSTALL);

export const FAKE_RELAY = relayName(FAKE_INSTALL);

const imageIdOf = (digest: string) => `sha256:image-${digest.replace(/^sha256:/, "")}`;

const infoOf = (digest: string): ImageInfo => ({ id: imageIdOf(digest), digest });

const matches = (labels: Record<string, string>, filter: Record<string, string>) =>
  Object.entries(filter).every(([key, value]) => labels[key] === value);

const isIdQuery = (command: string[]) => command.join(" ") === "id -u";

const startsWith = (command: string[], prefix: string[]) =>
  prefix.every((part, index) => command[index] === part);

export const stdinOf = (exec: FakeExec) => Buffer.concat(exec.stdin);

const recordStdin = (record: FakeExec, stdin: NodeJS.ReadableStream | undefined) =>
  new Promise<void>((resolve) => {
    if (stdin === undefined) {
      resolve();

      return;
    }

    stdin.on("data", (chunk: Buffer | string) => record.stdin.push(Buffer.from(chunk)));

    stdin.once("end", () => resolve());

    stdin.once("error", () => resolve());
  });

const runScript = async (script: FakeExecScript, io: ExecIo, stdinDone: Promise<void>) => {
  await stdinDone;

  if (script.stdout !== undefined) {
    io.stdout.write(script.stdout);
  }

  if (script.stderr !== undefined) {
    io.stderr.write(script.stderr);
  }

  return script.code ?? 0;
};

const GUEST_PROGRAMS = ["sh", "cat"];

const isWithinAny = (part: string, roots: string[]) =>
  roots.some((root) => part === root || part.startsWith(`${root}/`));

const isPiSessionExec = (spec: ExecSpec) => spec.env.PINATA_LAUNCH_ID !== undefined;

const isRootExec = (spec: ExecSpec) => spec.user === "0";

const runsInGuest = (spec: ExecSpec, containerSpec: ContainerSpec | undefined) => {
  const binds = (containerSpec?.mounts ?? [])
    .filter((mount) => mount.kind === "bind" && mount.source === mount.target)
    .map((mount) => mount.target);

  return (
    !isPiSessionExec(spec) &&
    !isRootExec(spec) &&
    GUEST_PROGRAMS.includes(spec.command[0] ?? "") &&
    spec.command.some((part) => part.includes(GUEST_PATHS.agentDir) || isWithinAny(part, binds))
  );
};

const catIn = async (agentDir: string, spec: ExecSpec, io: ExecIo) => {
  const texts = await Promise.all(
    spec.command
      .slice(1)
      .map((path) => readFile(path.replaceAll(GUEST_PATHS.agentDir, agentDir)).catch(() => undefined)),
  );

  texts.forEach((text) => {
    if (text !== undefined) {
      io.stdout.write(text);
    }
  });

  return texts.every((text) => text !== undefined) ? 0 : 1;
};

const shellIn = (agentDir: string, spec: ExecSpec, env: Record<string, string>, io: ExecIo) =>
  new Promise<number>((resolve) => {
    const [file = "sh", ...args] = spec.command.map((part) =>
      part.replaceAll(GUEST_PATHS.agentDir, agentDir),
    );
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, ...spec.env },
    });

    child.stdout.pipe(io.stdout, { end: false });

    child.stderr.pipe(io.stderr, { end: false });

    if (io.stdin === undefined) {
      child.stdin.end();
    } else {
      io.stdin.pipe(child.stdin);
    }

    child.once("error", () => resolve(127));

    child.once("close", (code) => resolve(code ?? 1));
  });

const contextFiles = async (dir: string) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  const contents = await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")));

  return Object.fromEntries(files.map((name, index) => [name, contents[index] ?? ""]));
};

export const createFakeBackend = (options: FakeBackendOptions = {}) => {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const volumeLabels = new Map<string, Record<string, string>>();
  const localImages = new Map(Object.entries(options.localImages ?? {}));
  const registry = new Map(Object.entries(options.registry ?? {}));
  const pulls: string[] = [];
  const builds: FakeBuild[] = [];
  const execs: FakeExec[] = [];
  const routes: FakeRoute[] = [];
  const stops: Array<{ id: string; timeoutSeconds?: number }> = [];
  const removals: string[] = [];
  const created: FakeContainer[] = [];
  const relays = new Map<string, FakeRelay>();
  const gone = new Set<string>();
  const danglingImages = new Set<string>();
  const builtImages = new Set<string>();
  const imageCreated = new Map<string, number>();
  const imageRemovals: string[] = [];

  const removalOf = (id: string) => gone.has(id);
  const sequence = { next: 0 };

  const nextId = (prefix: string) => {
    sequence.next += 1;

    return `${prefix}-${sequence.next}`;
  };

  const container = (id: string) => {
    const found = containers.get(id);

    if (found === undefined) {
      throw new LauncherError(`no such container ${id}`);
    }

    return found;
  };

  const setState = (id: string, state: ContainerState) => {
    const found = container(id);

    containers.set(id, { ...found, summary: { ...found.summary, state } });
  };

  const pull = (reference: string) => {
    const digest = registry.get(reference);

    if (digest === undefined) {
      throw new LauncherError(`image ${reference} not found`);
    }

    pulls.push(reference);

    localImages.set(reference, digest);

    return digest;
  };

  const pullImage = async (reference: string, digest?: string) => {
    const local = localImages.get(reference);
    const present =
      local === undefined || (digest !== undefined && local !== digest) ? pull(reference) : local;

    if (digest !== undefined && present !== digest) {
      throw new LauncherError(`image ${reference} has digest ${present}, expected ${digest}`);
    }

    return infoOf(present);
  };

  const presentDigests = () => [...new Set([...localImages.values(), ...danglingImages])];

  const resolveImage = async (reference: string) => {
    const digest =
      localImages.get(reference) ?? presentDigests().find((value) => imageIdOf(value) === reference);

    return digest === undefined ? undefined : infoOf(digest);
  };

  const defaultExec = (spec: ExecSpec, io: ExecIo, stdinDone: Promise<void>) => {
    const script = (options.execScripts ?? []).find((entry) => startsWith(spec.command, entry.command));

    if (script !== undefined) {
      return runScript(script, io, stdinDone);
    }

    if (isIdQuery(spec.command)) {
      io.stdout.write(`${fakeUidOf(spec.user)}\n`);

      return 0;
    }

    return options.guestAgentDir !== undefined &&
      spec.command[0] === "sh" &&
      !isPiSessionExec(spec) &&
      !isRootExec(spec)
      ? shellIn(options.guestAgentDir, spec, {}, io)
      : 0;
  };

  const inGuest = (spec: ExecSpec, io: ExecIo) => {
    const containerSpec = containers.get(spec.containerId)?.spec;

    if (options.guestAgentDir === undefined || !runsInGuest(spec, containerSpec)) {
      return undefined;
    }

    return spec.command[0] === "cat"
      ? catIn(options.guestAgentDir, spec, io)
      : shellIn(options.guestAgentDir, spec, containerSpec?.env ?? {}, io);
  };

  const assertRunning = (id: string) => {
    const state = containers.get(id)?.summary.state;

    if (removalOf(id) || (state !== undefined && state !== "running")) {
      throw new LauncherError(`container ${id} is not running`);
    }
  };

  const runExec = async (spec: ExecSpec, io: ExecIo) => {
    assertRunning(spec.containerId);

    const record: FakeExec = { spec, tty: io.tty, size: io.size, resizes: [], stdin: [] };

    execs.push(record);

    const stdinDone = recordStdin(record, io.stdin);
    const unsubscribe = io.onResize?.((size) => record.resizes.push(size));

    try {
      const answered = (await inGuest(spec, io)) ?? (await options.exec?.(spec, io));

      return answered ?? (await defaultExec(spec, io, stdinDone));
    } finally {
      unsubscribe?.();
    }
  };

  const networks = new Map<string, string>();
  const foreignNetworks = new Map<string, Record<string, string>>();
  const removedNetworks = new Set<string>();
  const networkIds = new Map<string, string>();

  const start = (id: string) => {
    const network = container(id).spec?.network;

    if (network?.kind === "internal" && removedNetworks.has(network.name)) {
      throw new LauncherError(`network ${network.name} not found`);
    }

    setState(id, "running");

    const spec = container(id).spec;
    const command = [...(spec?.entrypoint ?? []), ...(spec?.command ?? [])];

    if (command.length > 0 && isFakeScript(command)) {
      const result = runFakeScript(command);

      containers.set(id, {
        ...container(id),
        logs: result.lines.map((line) => line.text),
        exitCode: result.code,
      });

      exit(id);
    }
  };

  const relaySummary = (name: string, relay: FakeRelay): ContainerSummary => ({
    id: relay.id,
    name,
    labels: { [LABELS.managed]: "true", [LABELS.install]: relay.install, [LABELS.role]: "relay" },
    state: "running",
    image: relay.imageId,
  });

  const relaySummaries = () => [...relays.entries()].map(([name, relay]) => relaySummary(name, relay));

  const drop = (id: string) => {
    if (containers.has(id)) {
      gone.add(id);
    }

    containers.delete(id);

    [...relays.entries()]
      .filter(([, relay]) => relay.id === id)
      .forEach(([name]) => {
        relays.delete(name);
      });
  };

  const exit = (id: string) => {
    if (containers.get(id)?.spec?.autoRemove === false) {
      setState(id, "stopped");

      return;
    }

    drop(id);
  };

  const logsOf = (id: string, lines: number) => {
    const logs = containers.get(id)?.logs ?? [];

    return logs.slice(Math.max(logs.length - lines, 0)).join("");
  };

  const attached = (name: string) =>
    [...relays.values()].some((relay) => networkName(relay.install) === name) ||
    [...containers.values()].some(
      (entry) =>
        entry.summary.state === "running" &&
        entry.spec?.network.kind === "internal" &&
        entry.spec.network.name === name,
    );

  const volumeInUse = (name: string) =>
    [...containers.values()].some((entry) =>
      (entry.spec?.mounts ?? []).some((mount) => mount.kind === "volume" && mount.source === name),
    );

  const tagsOf = (digest: string) =>
    [...localImages.entries()].filter(([, value]) => value === digest).map(([tag]) => tag);

  const imageUsed = (id: string) =>
    [...containers.values()].some((entry) => entry.summary.image === id) ||
    [...relays.values()].some((relay) => relay.imageId === id);

  const imageSummary = (digest: string): ImageSummary => ({
    id: imageIdOf(digest),
    tags: tagsOf(digest),
    labels: builtImages.has(digest) ? { [LABELS.managed]: "true" } : {},
    inUse: imageUsed(imageIdOf(digest)),
    created: imageCreated.get(digest) ?? 0,
  });

  const ageImages = (seconds: number) => {
    [...imageCreated.entries()].forEach(([digest, created]) => {
      imageCreated.set(digest, created - seconds);
    });
  };

  const vm: Vm = {
    ensureRunning: async () => undefined,
    coverage: async () => undefined,
    reconcile: async () => undefined,
    ensureTrust: async () => undefined,
    inspect: async () => ({ state: "absent" }),
    apply: async () => "created",
    size: async () => undefined,
    stop: async () => "stopped",
    ...options.vm,
  };

  const summaries = () => [...[...containers.values()].map((entry) => entry.summary), ...relaySummaries()];

  const prepareNetwork = (install: string) => {
    const name = networkName(install);

    if (foreignNetworks.has(name)) {
      throw new LauncherError(
        `network ${name} exists but is not managed by pinata`,
        "remove that network from the sandbox VM so pinata can create its own",
      );
    }

    networks.set(name, install);

    networkIds.set(name, networkIds.get(name) ?? nextId("network"));

    removedNetworks.delete(name);

    return name;
  };

  const backendFor = (install: string): Backend => ({
    vm,
    detect: async () => ({ available: true }),
    pullImage,
    resolveImage,
    buildImage: async (contextDir, tag, { args, progress, offline } = {}) => {
      const digest = `sha256:${nextId("built")}`;

      progress?.("Step 1/1");
      const previous = localImages.get(tag);

      builds.push({ contextDir, tag, args, offline, files: await contextFiles(contextDir) });

      localImages.set(tag, digest);

      builtImages.add(digest);

      imageCreated.set(digest, Math.floor(Date.now() / 1000));

      if (previous !== undefined && tagsOf(previous).length === 0) {
        danglingImages.add(previous);
      }

      return infoOf(digest);
    },
    listImages: async () => presentDigests().map(imageSummary),
    removeImage: async (reference) => {
      const tagged = localImages.get(reference);
      const digest = tagged ?? presentDigests().find((value) => imageIdOf(value) === reference);

      if (digest === undefined || imageUsed(imageIdOf(digest))) {
        return false;
      }

      imageRemovals.push(reference);

      if (tagged !== undefined) {
        localImages.delete(reference);

        return true;
      }

      tagsOf(digest).forEach((tag) => {
        localImages.delete(tag);
      });

      danglingImages.delete(digest);

      return true;
    },
    findContainers: async (labels) =>
      summaries().filter((summary) =>
        matches(summary.labels, { ...labels, [LABELS.managed]: "true", [LABELS.install]: install }),
      ),
    listOtherInstallSessions: async () =>
      summaries().filter(
        (summary) =>
          matches(summary.labels, { [LABELS.managed]: "true", [LABELS.role]: "agent" }) &&
          summary.state === "running" &&
          summary.labels[LABELS.install] !== install,
      ),
    createContainer: async (spec) => {
      const taken = [...containers.values()].some((entry) => entry.summary.name === spec.name);

      if (taken) {
        throw new LauncherError(`unexpected name clash: container name ${spec.name} is already in use`);
      }

      const id = nextId("container");
      const labels = { ...spec.labels, [LABELS.managed]: "true", [LABELS.install]: install };
      const entry = {
        spec,
        summary: { id, name: spec.name, labels, state: "created" as const, image: spec.image },
      };

      containers.set(id, entry);

      created.push(entry);

      return { id };
    },
    startContainer: async (id) => start(id),
    stopContainer: async (id, timeoutSeconds) => {
      stops.push({ id, timeoutSeconds });

      exit(id);
    },
    removeContainer: async (id) => {
      removals.push(id);

      drop(id);
    },
    inspectContainer: async (id) => {
      const found = containers.get(id);

      return found === undefined
        ? undefined
        : { id, labels: found.summary.labels, state: found.summary.state, exitCode: found.exitCode ?? 0 };
    },
    containerLogs: async (id, lines) => logsOf(id, lines),
    exec: runExec,
    ensureVolume: async (name, labels = {}) => {
      volumeLabels.set(
        name,
        volumeLabels.get(name) ?? { ...labels, [LABELS.managed]: "true", [LABELS.install]: install },
      );

      volumes.add(name);
    },
    listVolumes: async () =>
      [...volumes]
        .filter((name) => volumeLabels.get(name)?.[LABELS.install] === install)
        .map((name) => ({
          name,
          labels: volumeLabels.get(name) ?? {},
          inUse: volumeInUse(name),
        })),
    removeVolume: async (name) => {
      if (volumeInUse(name)) {
        throw new LauncherError(
          `volume ${name} is in use by a sandbox container`,
          "end the pi sessions that use it, then run the command again",
        );
      }

      volumes.delete(name);

      volumeLabels.delete(name);
    },
    prepareRelay: async ({ hostPort, imageId, preamble }) => {
      const name = prepareNetwork(install);
      const relay = relays.get(relayName(install));
      const network = networkIds.get(name) ?? "";

      routes.push({ hostPort, imageId, preamble });

      const reusable =
        relay !== undefined &&
        relay.hostPort === hostPort &&
        relay.preamble === preamble &&
        relay.network === network;

      if (!reusable) {
        relays.set(relayName(install), {
          id: nextId("relay"),
          install,
          hostPort,
          imageId,
          preamble,
          network,
        });
      }

      return name;
    },
    prepareNetwork: async () => prepareNetwork(install),
    removeNetwork: async () => {
      const name = networkName(install);

      if (!networks.has(name) || attached(name)) {
        return false;
      }

      networks.delete(name);

      networkIds.delete(name);

      removedNetworks.add(name);

      return true;
    },
    listOlderBuildObjects: async () => ({
      containers: summaries().filter((summary) => isOlderBuild(summary.name, summary.labels)),
      volumes: [...volumes].filter((name) => isOlderBuild(name, volumeLabels.get(name) ?? {})),
      networks: [
        ...[...networks.entries()].map(([name, owner]) => ({
          name,
          labels: { [LABELS.managed]: "true", [LABELS.install]: owner },
        })),
        ...[...foreignNetworks.entries()].map(([name, labels]) => ({ name, labels })),
      ]
        .filter((network) => isOlderBuild(network.name, network.labels))
        .map((network) => network.name),
    }),
    removeNamedNetwork: async (name) => {
      if (attached(name) || !foreignNetworks.has(name)) {
        return false;
      }

      foreignNetworks.delete(name);

      return true;
    },
    status: async () => ({ socket: "/fake/docker.sock" }),
  });

  const backend = backendFor(FAKE_INSTALL);

  const addContainer = (summary: Omit<ContainerSummary, "id">) => {
    const id = nextId("container");
    const labels = { [LABELS.install]: FAKE_INSTALL, ...summary.labels };

    containers.set(id, { summary: { ...summary, labels, id } });

    return id;
  };

  const plantForeignNetwork = (name: string, labels: Record<string, string> = {}) => {
    foreignNetworks.set(name, labels);
  };

  const dropNetwork = (name: string) => {
    networks.delete(name);

    networkIds.delete(name);

    foreignNetworks.delete(name);
  };

  const hasNetwork = (name: string) => networks.has(name) || foreignNetworks.has(name);

  const guestPath = (name: string) => {
    if (options.guestAgentDir === undefined) {
      throw new Error("guest files need the guestAgentDir option");
    }

    return join(options.guestAgentDir, name);
  };

  const guestFile = (name: string) => readFile(guestPath(name), "utf8").catch(() => undefined);

  const writeGuestFile = (name: string, text: string) => writeFile(guestPath(name), text);

  return {
    backend,
    backendFor,
    containers,
    volumes,
    volumeLabels,
    networks,
    plantForeignNetwork,
    hasNetwork,
    dropNetwork,
    guestFile,
    writeGuestFile,
    localImages,
    pulls,
    builds,
    imageRemovals,
    ageImages,
    execs,
    routes,
    stops,
    removals,
    created,
    relays,
    addContainer,
  };
};
