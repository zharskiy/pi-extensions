import type { ContainerSpec, ContainerState, ContainerSummary, MountSpec, NetworkRef } from "../types.ts";

export interface EngineContainer {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string> | null;
  State?: string;
  Image?: string;
}

const NANO_CPUS = 1_000_000_000;

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

const networkModeOf = (network: NetworkRef) => (network.kind === "none" ? "none" : network.name);

export const envList = (env: Record<string, string>) =>
  Object.entries(env).map(([key, value]) => `${key}=${value}`);

const scaled = (value: number | undefined, factor: number) =>
  value === undefined ? undefined : Math.round(value * factor);

export const containerBody = (spec: ContainerSpec) => ({
  Image: spec.image,
  Labels: spec.labels,
  Env: envList(spec.env),
  WorkingDir: spec.workdir,
  HostConfig: {
    Mounts: spec.mounts.map(mountOf),
    NetworkMode: networkModeOf(spec.network),
    ReadonlyRootfs: spec.readOnlyRoot,
    Tmpfs: Object.fromEntries(spec.tmpfs.map(tmpfsEntry)),
    Init: spec.init,
    NanoCpus: scaled(spec.resources.cpus, NANO_CPUS),
    Memory: scaled(spec.resources.memoryGiB, GIB),
  },
});

export const summaryOf = (container: EngineContainer): ContainerSummary => ({
  id: container.Id,
  name: (container.Names?.[0] ?? "").replace(/^\//, ""),
  labels: container.Labels ?? {},
  state: STATES[container.State ?? ""] ?? "unknown",
  image: container.Image ?? "",
});

export const labelFilters = (labels: Record<string, string>) =>
  JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) });
