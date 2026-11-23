import type {
  ContainerInspect,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  MountSpec,
  NetworkRef,
} from "../types.ts";

export interface EngineContainer {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string> | null;
  State?: string;
  Image?: string;
}

const NANO_CPUS = 1_000_000_000;

const MIB = 1024 ** 2;

const GIB = 1024 ** 3;

const STATES: Record<string, ContainerState> = {
  running: "running",
  exited: "stopped",
  dead: "stopped",
  created: "created",
};

const mountOf = (mount: MountSpec) => ({
  Type: mount.kind,
  Source: mount.source,
  Target: mount.target,
  ReadOnly: mount.readOnly,
});

const tmpfsEntry = (entry: string) => {
  const [path = entry, ...options] = entry.split(":");

  return [path, options.join(":")];
};

const networkModeOf = (network: NetworkRef) => {
  if (network.kind === "container") {
    return `container:${network.id}`;
  }

  return network.kind === "none" ? "none" : network.name;
};

const networkingOf = (network: NetworkRef) =>
  network.kind === "internal" && network.alias !== undefined
    ? { NetworkingConfig: { EndpointsConfig: { [network.name]: { Aliases: [network.alias] } } } }
    : {};

export const confined = (pidsLimit: number, capabilities: string[] = []) => ({
  CapDrop: ["ALL"],
  ...(capabilities.length === 0 ? {} : { CapAdd: capabilities }),
  SecurityOpt: ["no-new-privileges"],
  PidsLimit: pidsLimit,
});

export const envList = (env: Record<string, string>) =>
  Object.entries(env).map(([key, value]) => `${key}=${value}`);

const scaled = (value: number | undefined, factor: number) =>
  value === undefined ? undefined : Math.round(value * factor);

const openFilesLimit = (openFiles: number | undefined) =>
  openFiles === undefined ? {} : { Ulimits: [{ Name: "nofile", Soft: openFiles, Hard: openFiles }] };

export const containerBody = (spec: ContainerSpec) => ({
  Image: spec.image,
  User: spec.user,
  Labels: spec.labels,
  Env: envList(spec.env),
  WorkingDir: spec.workdir,
  Entrypoint: spec.entrypoint,
  Cmd: spec.command,
  HostConfig: {
    Mounts: spec.mounts.map(mountOf),
    NetworkMode: networkModeOf(spec.network),
    ReadonlyRootfs: spec.readOnlyRoot,
    Tmpfs: Object.fromEntries(spec.tmpfs.map(tmpfsEntry)),
    Init: spec.init,
    AutoRemove: spec.autoRemove,
    ...confined(spec.resources.pids, spec.capabilities),
    ...openFilesLimit(spec.resources.openFiles),
    NanoCpus: scaled(spec.resources.cpus, NANO_CPUS),
    Memory: scaled(spec.resources.memoryGiB, GIB),
    ShmSize: scaled(spec.resources.shmMiB, MIB),
  },
  ...networkingOf(spec.network),
});

export interface EngineInspect {
  Id: string;
  State?: { Status?: string; ExitCode?: number };
  Config?: { Labels?: Record<string, string> | null };
}

const stateOf = (status: string | undefined) => STATES[status ?? ""] ?? "unknown";

export const inspectOf = (container: EngineInspect): ContainerInspect => ({
  id: container.Id,
  labels: container.Config?.Labels ?? {},
  state: stateOf(container.State?.Status),
  ...(container.State?.ExitCode === undefined ? {} : { exitCode: container.State.ExitCode }),
});

export const summaryOf = (container: EngineContainer): ContainerSummary => ({
  id: container.Id,
  name: (container.Names?.[0] ?? "").replace(/^\//, ""),
  labels: container.Labels ?? {},
  state: stateOf(container.State),
  image: container.Image ?? "",
});

export const labelFilters = (labels: Record<string, string>) =>
  JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) });
