import { spawn } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
  Backend,
  BackendCapabilities,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  ExecIo,
  ExecSpec,
  ImageInfo,
  TerminalSize,
} from "../../backend/index.ts";
import { LABELS } from "../../backend/index.ts";
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
  policyHash: string;
  imageId: string;
}

interface FakeBackendOptions {
  capabilities?: Partial<BackendCapabilities>;
  localImages?: Record<string, string>;
  registry?: Record<string, string>;
  exec?: (spec: ExecSpec, io: ExecIo) => Promise<number> | number;
  execScripts?: FakeExecScript[];
  proxyListenHosts?: string[];
  routeNotices?: string[];
  guestAgentDir?: string;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  singleFileMount: true,
  sshAgent: true,
};

const NETWORK_PREFIX = "pi-sandbox";

const RELAY_ADDRESS = "10.89.0.2:3128";

const SHORT_REPO_HASH = 12;

const PRUNABLE_NETWORK = /^pi-sandbox(?:-([0-9a-f]{12}))?$/;

const RESET_HINT = "run pi sandbox reset";

const repoNetworkOf = (repoHash: string) => `${NETWORK_PREFIX}-${repoHash.slice(0, SHORT_REPO_HASH)}`;

const imageIdOf = (digest: string) => `sha256:image-${digest.replace(/^sha256:/, "")}`;

const infoOf = (digest: string): ImageInfo => ({ id: imageIdOf(digest), digest });

const matches = (labels: Record<string, string>, wanted: Record<string, string>) =>
  Object.entries(wanted).every(([key, value]) => labels[key] === value);

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

const archiveOf = async (tarPath: string) => {
  const found = await stat(tarPath).catch(() => undefined);

  if (found === undefined) {
    throw new LauncherError(`volume archive ${tarPath} does not exist`);
  }

  return readFile(tarPath);
};

const contextFiles = async (dir: string) => {
  const names = await readdir(dir);
  const contents = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));

  return Object.fromEntries(names.map((name, index) => [name, contents[index] ?? ""]));
};

export const createFakeBackend = (options: FakeBackendOptions = {}) => {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const volumeLabels = new Map<string, Record<string, string>>();
  const volumeData = new Map<string, Buffer>();
  const localImages = new Map(Object.entries(options.localImages ?? {}));
  const registry = new Map(Object.entries(options.registry ?? {}));
  const pulls: string[] = [];
  const builds: FakeBuild[] = [];
  const execs: FakeExec[] = [];
  const routes: FakeRoute[] = [];
  const stops: Array<{ id: string; timeoutSeconds?: number }> = [];
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

  const resolveImage = async (reference: string) => {
    const digest =
      localImages.get(reference) ?? [...localImages.values()].find((value) => imageIdOf(value) === reference);

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

    if (state !== undefined && state !== "running") {
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

  const networks = new Set<string>();
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

  const dropRepoNetwork = (repoHash: string | undefined) => {
    const remaining = [...containers.values()].some(
      (entry) => entry.summary.labels[LABELS.repoHash] === repoHash,
    );

    if (repoHash === undefined || remaining) {
      return;
    }

    networks.delete(repoNetworkOf(repoHash));

    removedNetworks.add(repoNetworkOf(repoHash));
  };

  const backend: Backend = {
    name: "colima",
    capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    detect: async () => ({ available: true, version: "fake" }),
    pullImage,
    resolveImage,
    buildImage: async (contextDir, tag) => {
      const digest = `sha256:${nextId("built")}`;

      builds.push({ contextDir, tag, files: await contextFiles(contextDir) });

      localImages.set(tag, digest);

      return infoOf(digest);
    },
    findContainers: async (labels) =>
      [...containers.values()]
        .map((entry) => entry.summary)
        .filter((summary) => matches(summary.labels, labels)),
    createContainer: async (spec) => {
      const taken = [...containers.values()].some((entry) => entry.summary.name === spec.name);

      if (taken) {
        throw new LauncherError(`container name ${spec.name} is already in use`, RESET_HINT);
      }

      const id = nextId("container");

      containers.set(id, {
        spec,
        summary: { id, name: spec.name, labels: spec.labels, state: "created", image: spec.image },
      });

      return { id };
    },
    startContainer: async (id) => start(id),
    stopContainer: async (id, timeoutSeconds) => {
      stops.push({ id, timeoutSeconds });

      setState(id, "stopped");
    },
    removeContainer: async (id, removal) => {
      const found = containers.get(id);

      if (found === undefined) {
        return;
      }

      const repoHash = found.summary.labels[LABELS.repoHash];

      containers.delete(id);

      if (removal?.keepNetwork !== true) {
        dropRepoNetwork(repoHash);
      }
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

      volumeData.delete(name);
    },
    exportVolume: async (name, tarPath) => {
      if (!volumes.has(name)) {
        throw new LauncherError(`volume ${name} does not exist`);
      }

      await writeFile(tarPath, volumeData.get(name) ?? Buffer.alloc(0));
    },
    importVolume: async (name, tarPath) => {
      const archive = await archiveOf(tarPath);

      volumeLabels.set(name, volumeLabels.get(name) ?? { [LABELS.managed]: "true" });

      volumes.add(name);

      volumeData.set(name, archive);
    },
    prepareProxyRoute: async ({ hostPort, repoHash, relay }) => {
      const name = repoNetworkOf(repoHash);
      const hint = `remove it (docker network rm ${name}) so the launcher can create its own`;

      if (externalNetworks.has(name)) {
        throw new LauncherError(`network ${name} exists but is not internal`, hint);
      }

      if (foreignNetworks.has(name)) {
        throw new LauncherError(`network ${name} exists but is not managed by pi-sandbox`, hint);
      }

      routes.push({ hostPort, policyHash: relay.policyHash, imageId: relay.imageId });

      networks.add(name);

      removedNetworks.delete(name);

      return {
        network: { kind: "internal", name },
        address: RELAY_ADDRESS,
        ...(options.routeNotices === undefined ? {} : { notices: options.routeNotices }),
      };
    },
    pruneNetworks: async (keepRepoHashes) => {
      const kept = new Set(keepRepoHashes.map((hash) => hash.slice(0, SHORT_REPO_HASH)));
      const removed = [...networks].filter((name) => {
        const match = PRUNABLE_NETWORK.exec(name);
        const attached = [...containers.values()].some(
          (entry) => entry.spec?.network.kind === "internal" && entry.spec.network.name === name,
        );

        return match !== null && !attached && (match[1] === undefined || !kept.has(match[1]));
      });

      removed.forEach((name) => {
        networks.delete(name);

        removedNetworks.add(name);
      });

      return removed;
    },
    proxyListenHosts: async () => options.proxyListenHosts ?? [],
    status: async () => ({ socket: "/fake/docker.sock" }),
  };

  const addContainer = (summary: Omit<ContainerSummary, "id">) => {
    const id = nextId("container");

    containers.set(id, { summary: { ...summary, id } });

    return id;
  };

  const plantNetwork = (name: string, managed = true, internal = true) => {
    if (!internal) {
      externalNetworks.add(name);

      return;
    }

    (managed ? networks : foreignNetworks).add(name);
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
    volumeData,
    networks,
    foreignNetworks,
    plantNetwork,
    hasNetwork,
    guestFile,
    localImages,
    pulls,
    builds,
    execs,
    routes,
    stops,
    addContainer,
  };
};
