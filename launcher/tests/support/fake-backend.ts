import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import { LABELS, recommendedVmSize } from "../../backend/index.ts";
import { GUEST_PATHS, LauncherError } from "../../shared/index.ts";
import { fakeUidOf } from "./fake-engine.ts";

interface FakeContainer {
  summary: ContainerSummary;
  spec?: ContainerSpec;
}

interface FakeBuild {
  contextDir: string;
  tag: string;
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
  repoHash: string;
  imageId: string;
}

interface FakeRelay {
  id: string;
  hostPort: number;
  imageId: string;
}

interface FakeBackendOptions {
  localImages?: Record<string, string>;
  registry?: Record<string, string>;
  exec?: (spec: ExecSpec, io: ExecIo) => Promise<number> | number;
  execScripts?: FakeExecScript[];
  routeNotices?: string[];
  guestAgentDir?: string;
  vm?: Partial<Vm>;
}

const NETWORK_PREFIX = "pi-sandbox";

const RELAY_ADDRESS = "pi-sandbox-proxy:3128";

const SHORT_REPO_HASH = 12;

const RESET_HINT = "run pi sandbox reset";

const repoNetworkOf = (repoHash: string) => `${NETWORK_PREFIX}-${repoHash.slice(0, SHORT_REPO_HASH)}`;

const imageIdOf = (digest: string) => `sha256:image-${digest.replace(/^sha256:/, "")}`;

const infoOf = (digest: string): ImageInfo => ({ id: imageIdOf(digest), digest });

const matches = (labels: Record<string, string>, filter: Record<string, string>) =>
  Object.entries(filter).every(([key, value]) => labels[key] === value);

const isIdQuery = (command: string[]) => command.join(" ") === "id -u";

const startsWith = (command: string[], prefix: string[]) =>
  prefix.every((part, index) => command[index] === part);

export const stdinFrom = (input: string | Buffer): NodeJS.ReadableStream =>
  Readable.from([Buffer.from(input)]);

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

const shellIn = (agentDir: string, spec: ExecSpec, io: ExecIo) =>
  new Promise<number>((resolve) => {
    const [file = "sh", ...args] = spec.command.map((part) =>
      part.replaceAll(GUEST_PATHS.agentDir, agentDir),
    );
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...spec.env },
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
  const names = await readdir(dir);
  const contents = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));

  return Object.fromEntries(names.map((name, index) => [name, contents[index] ?? ""]));
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
  const waits: string[] = [];
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

    return options.guestAgentDir !== undefined && spec.command[0] === "sh"
      ? shellIn(options.guestAgentDir, spec, io)
      : 0;
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
      return options.exec === undefined
        ? await defaultExec(spec, io, stdinDone)
        : await options.exec(spec, io);
    } finally {
      unsubscribe?.();
    }
  };

  const networks = new Map<string, string>();
  const foreignNetworks = new Set<string>();
  const externalNetworks = new Set<string>();
  const removedNetworks = new Set<string>();

  const start = (id: string) => {
    const network = container(id).spec?.network;

    if (network?.kind === "internal" && removedNetworks.has(network.name)) {
      throw new LauncherError(`network ${network.name} not found`);
    }

    setState(id, "running");
  };

  const relaySummary = (repoHash: string, relay: FakeRelay): ContainerSummary => ({
    id: relay.id,
    name: `${NETWORK_PREFIX}-relay-${repoHash.slice(0, SHORT_REPO_HASH)}`,
    labels: {
      [LABELS.managed]: "true",
      [LABELS.relay]: "true",
      [LABELS.repoHash]: repoHash,
      [LABELS.relayPort]: String(relay.hostPort),
    },
    state: "running",
    image: relay.imageId,
  });

  const relaySummaries = () =>
    [...relays.entries()].map(([repoHash, relay]) => relaySummary(repoHash, relay));

  const drop = (id: string) => {
    if (containers.has(id)) {
      gone.add(id);
    }

    containers.delete(id);

    [...relays.entries()]
      .filter(([, relay]) => relay.id === id)
      .forEach(([repoHash]) => {
        relays.delete(repoHash);
      });
  };

  const attached = (name: string) =>
    [...containers.values()].some(
      (entry) => entry.spec?.network.kind === "internal" && entry.spec.network.name === name,
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
    ensureShares: async () => undefined,
    size: async () => undefined,
    recommendedSize: recommendedVmSize,
    stop: async () => "stopped",
    ...options.vm,
  };

  const backend: Backend = {
    vm,
    detect: async () => ({ available: true, version: "fake" }),
    pullImage,
    resolveImage,
    buildImage: async (contextDir, tag) => {
      const digest = `sha256:${nextId("built")}`;
      const previous = localImages.get(tag);

      builds.push({ contextDir, tag, files: await contextFiles(contextDir) });

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
      [...[...containers.values()].map((entry) => entry.summary), ...relaySummaries()].filter((summary) =>
        matches(summary.labels, labels),
      ),
    createContainer: async (spec) => {
      const taken = [...containers.values()].some((entry) => entry.summary.name === spec.name);

      if (taken) {
        throw new LauncherError(`container name ${spec.name} is already in use`, RESET_HINT);
      }

      const id = nextId("container");
      const entry = {
        spec,
        summary: { id, name: spec.name, labels: spec.labels, state: "created" as const, image: spec.image },
      };

      containers.set(id, entry);

      created.push(entry);

      return { id };
    },
    startContainer: async (id) => start(id),
    stopContainer: async (id, timeoutSeconds) => {
      stops.push({ id, timeoutSeconds });

      drop(id);
    },
    waitRemoved: async (id) => {
      waits.push(id);
    },
    removeContainer: async (id) => {
      removals.push(id);

      drop(id);
    },
    exec: runExec,
    ensureVolume: async (name, labels = {}) => {
      volumeLabels.set(name, volumeLabels.get(name) ?? { ...labels, [LABELS.managed]: "true" });

      volumes.add(name);
    },
    listVolumes: async () =>
      [...volumes]
        .filter((name) => volumeLabels.get(name)?.[LABELS.managed] === "true")
        .map((name) => ({
          name,
          labels: volumeLabels.get(name) ?? {},
          inUse: [...containers.values()].some((entry) =>
            (entry.spec?.mounts ?? []).some((mount) => mount.kind === "volume" && mount.source === name),
          ),
        })),
    removeVolume: async (name) => {
      volumes.delete(name);

      volumeLabels.delete(name);
    },
    prepareProxyRoute: async ({ hostPort, repoHash, imageId }) => {
      const name = repoNetworkOf(repoHash);

      if (externalNetworks.has(name)) {
        throw new LauncherError(`network ${name} exists but is not internal`, "run pi sandbox gc");
      }

      if (foreignNetworks.has(name)) {
        throw new LauncherError(
          `network ${name} exists but is not managed by pi-sandbox`,
          "remove that network from the sandbox VM so the launcher can create its own",
        );
      }

      routes.push({ hostPort, repoHash, imageId });

      networks.set(name, repoHash);

      removedNetworks.delete(name);

      const relay = relays.get(repoHash);

      if (relay === undefined || relay.hostPort !== hostPort) {
        relays.set(repoHash, { id: nextId("relay"), hostPort, imageId });
      }

      return {
        network: { kind: "internal", name },
        address: RELAY_ADDRESS,
        ...(options.routeNotices === undefined ? {} : { notices: options.routeNotices }),
      };
    },
    listNetworks: async () =>
      [...networks.entries()].map(([name, repoHash]) => ({
        name,
        labels: { [LABELS.managed]: "true", [LABELS.repoHash]: repoHash },
      })),
    removeRepoNetwork: async (repoHash) => {
      const name = repoNetworkOf(repoHash);

      if (!networks.has(name) || attached(name)) {
        return false;
      }

      networks.delete(name);

      removedNetworks.add(name);

      return true;
    },
    status: async () => ({ socket: "/fake/docker.sock" }),
  };

  const addContainer = (summary: Omit<ContainerSummary, "id">) => {
    const id = nextId("container");

    containers.set(id, { summary: { ...summary, id } });

    return id;
  };

  const plantNetwork = (name: string, managed = true, internal = true, repoHash = "") => {
    if (!internal) {
      externalNetworks.add(name);

      return;
    }

    if (managed) {
      networks.set(name, repoHash);

      return;
    }

    foreignNetworks.add(name);
  };

  const hasNetwork = (name: string) =>
    networks.has(name) || foreignNetworks.has(name) || externalNetworks.has(name);

  const guestFile = (name: string) => {
    if (options.guestAgentDir === undefined) {
      throw new Error("guestFile needs the guestAgentDir option");
    }

    return readFile(join(options.guestAgentDir, name), "utf8").catch(() => undefined);
  };

  return {
    backend,
    containers,
    volumes,
    volumeLabels,
    networks,
    foreignNetworks,
    plantNetwork,
    hasNetwork,
    guestFile,
    localImages,
    pulls,
    builds,
    imageRemovals,
    ageImages,
    execs,
    routes,
    stops,
    waits,
    removals,
    created,
    relays,
    addContainer,
  };
};
