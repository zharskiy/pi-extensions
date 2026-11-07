import { readdir, readFile } from "node:fs/promises";
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
import { LauncherError } from "../../shared/index.ts";

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
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  singleFileMount: true,
  sshAgent: true,
  internalNetwork: true,
};

const RELAY_NETWORK = "pi-sandbox";

const RELAY_ADDRESS = "10.89.0.2:3128";

const imageIdOf = (digest: string) => `sha256:image-${digest.replace(/^sha256:/, "")}`;

const infoOf = (digest: string): ImageInfo => ({ id: imageIdOf(digest), digest });

const matches = (labels: Record<string, string>, wanted: Record<string, string>) =>
  Object.entries(wanted).every(([key, value]) => labels[key] === value);

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

const contextFiles = async (dir: string) => {
  const names = await readdir(dir);
  const contents = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));

  return Object.fromEntries(names.map((name, index) => [name, contents[index] ?? ""]));
};

export const createFakeBackend = (options: FakeBackendOptions = {}) => {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
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

    return script === undefined ? 0 : runScript(script, io, stdinDone);
  };

  const runExec = async (spec: ExecSpec, io: ExecIo) => {
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
      const id = nextId("container");

      containers.set(id, {
        spec,
        summary: { id, name: spec.name, labels: spec.labels, state: "created", image: spec.image },
      });

      return { id };
    },
    startContainer: async (id) => setState(id, "running"),
    stopContainer: async (id, timeoutSeconds) => {
      stops.push({ id, timeoutSeconds });

      setState(id, "stopped");
    },
    removeContainer: async (id) => {
      container(id);

      containers.delete(id);
    },
    exec: runExec,
    ensureVolume: async (name) => {
      volumes.add(name);
    },
    removeVolume: async (name) => {
      volumes.delete(name);
    },
    exportVolume: async () => undefined,
    importVolume: async () => undefined,
    prepareProxyRoute: async (hostPort, policyHash, imageId) => {
      routes.push({ hostPort, policyHash, imageId });

      return { network: { kind: "internal", name: RELAY_NETWORK }, address: RELAY_ADDRESS };
    },
    status: async () => ({ socket: "/fake/docker.sock" }),
  };

  const addContainer = (summary: Omit<ContainerSummary, "id">) => {
    const id = nextId("container");

    containers.set(id, { summary: { ...summary, id } });

    return id;
  };

  return { backend, containers, volumes, localImages, pulls, builds, execs, routes, stops, addContainer };
};
