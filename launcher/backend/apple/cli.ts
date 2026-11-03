import type { ContainerState, ContainerSummary, MountSpec } from "../types.ts";

export const CONTAINER_CLI = "container";

export const APPLE_SSH_SOCKET = "/var/host-services/ssh-auth.sock";

export const APPLE_PROXY_NETWORK = "pi-sandbox";

export const APPLE_COMMANDS = {
  systemStatus: ["system", "status"],
  version: ["--version"],
  imageInspect: ["image", "inspect"],
  imagePull: ["image", "pull"],
  build: ["build"],
  list: ["list", "--all", "--format", "json"],
  create: ["create"],
  run: ["run"],
  start: ["start"],
  stop: ["stop"],
  remove: ["delete"],
  exec: ["exec"],
  volumeInspect: ["volume", "inspect"],
  volumeCreate: ["volume", "create"],
  volumeRemove: ["volume", "delete"],
  networkInspect: ["network", "inspect"],
  networkCreate: ["network", "create"],
} as const;

export const APPLE_FLAGS = {
  tag: "--tag",
  file: "--file",
  name: "--name",
  label: "--label",
  env: "--env",
  workdir: "--workdir",
  user: "--user",
  tmpfs: "--tmpfs",
  readOnly: "--read-only",
  init: "--init",
  cpus: "--cpus",
  memory: "--memory",
  network: "--network",
  noDns: "--no-dns",
  ssh: "--ssh",
  mount: "--mount",
  volume: "--volume",
  entrypoint: "--entrypoint",
  removeOnExit: "--rm",
  interactive: "--interactive",
  tty: "--tty",
  internal: "--internal",
  force: "--force",
  time: "--time",
} as const;

const MIB_PER_GIB = 1024;

export const memoryArgument = (memoryGiB: number) => `${Math.round(memoryGiB * MIB_PER_GIB)}M`;

export const bindArgument = (mount: MountSpec) =>
  [
    `type=bind`,
    `source=${mount.source}`,
    `target=${mount.target}`,
    ...(mount.readOnly ? ["readonly"] : []),
  ].join(",");

export const volumeArgument = (mount: MountSpec) =>
  mount.readOnly ? `${mount.source}:${mount.target}:ro` : `${mount.source}:${mount.target}`;

type Json = Record<string, unknown>;

const record = (value: unknown): Json => (typeof value === "object" && value !== null ? (value as Json) : {});

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

const firstEntry = (value: unknown) => (Array.isArray(value) ? value[0] : value);

const parseJson = (output: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
};

export const imageDigestOf = (output: string) => {
  const image = record(firstEntry(parseJson(output)));

  return (
    text(record(image.index).digest) ??
    text(record(image.descriptor).digest) ??
    text(record(record(image.configuration).descriptor).digest) ??
    text(image.digest)
  );
};

const STATES: Record<string, ContainerState> = {
  running: "running",
  stopped: "stopped",
  exited: "stopped",
  created: "created",
};

const summaryOf = (entry: unknown): ContainerSummary => {
  const container = record(entry);
  const configuration = record(container.configuration);
  const id = text(configuration.id) ?? text(container.id) ?? "";

  return {
    id,
    name: id,
    labels: record(configuration.labels) as Record<string, string>,
    state: STATES[text(container.status) ?? ""] ?? "unknown",
    image: text(record(configuration.image).reference) ?? "",
  };
};

export const containerSummariesOf = (output: string) => {
  const containers = parseJson(output);

  return (Array.isArray(containers) ? containers : []).map(summaryOf);
};

const APPLE_NETWORK_FIELDS = {
  gateway: [
    ["status", "gateway"],
    ["status", "ipv4Gateway"],
    ["config", "gateway"],
  ],
  internal: [
    ["config", "internal"],
    ["status", "internal"],
  ],
  hostOnlyMode: [["config", "mode"]],
  labels: [["config", "labels"], ["labels"]],
} as const;

const APPLE_HOST_ONLY_MODE = "hostOnly";

export const APPLE_MANAGED_LABEL = "pi-sandbox.managed";

export interface AppleNetwork {
  gateway?: string;
  internal?: boolean;
  managed: boolean;
}

const at = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => record(current)[key], value);

const firstAt = (value: unknown, paths: ReadonlyArray<readonly string[]>) =>
  paths.map((path) => at(value, path)).find((found) => found !== undefined);

const internalOf = (network: unknown) => {
  const flag = firstAt(network, APPLE_NETWORK_FIELDS.internal);
  const mode = text(firstAt(network, APPLE_NETWORK_FIELDS.hostOnlyMode));

  if (typeof flag === "boolean") {
    return flag;
  }

  return mode === undefined ? undefined : mode === APPLE_HOST_ONLY_MODE;
};

export const networkOf = (output: string): AppleNetwork => {
  const network = firstEntry(parseJson(output));
  const labels = record(firstAt(network, APPLE_NETWORK_FIELDS.labels));

  return {
    gateway: text(firstAt(network, APPLE_NETWORK_FIELDS.gateway)),
    internal: internalOf(network),
    managed: labels[APPLE_MANAGED_LABEL] === "true",
  };
};
