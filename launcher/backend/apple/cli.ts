import { LABELS } from "../labels.ts";
import type { ContainerState, ContainerSummary, MountSpec } from "../types.ts";

export const CONTAINER_CLI = "container";

export const APPLE_SSH_SOCKET = "/var/host-services/ssh-auth.sock";

export const APPLE_COMMANDS = {
  systemStatus: ["system", "status"],
  version: ["--version"],
  imageInspect: ["image", "inspect"],
  imagePull: ["image", "pull"],
  build: ["build"],
  list: ["list", "--all", "--format", "json"],
  inspect: ["inspect"],
  create: ["create"],
  run: ["run"],
  start: ["start"],
  stop: ["stop"],
  remove: ["delete"],
  exec: ["exec"],
  volumeInspect: ["volume", "inspect"],
  volumeCreate: ["volume", "create"],
  volumeRemove: ["volume", "delete"],
  volumeList: ["volume", "list", "--format", "json"],
  networkInspect: ["network", "inspect"],
  networkCreate: ["network", "create"],
  networkRemove: ["network", "delete"],
  networkList: ["network", "list", "--format", "json"],
} as const;

export const APPLE_FLAGS = {
  tag: "--tag",
  buildArg: "--build-arg",
  file: "--file",
  name: "--name",
  label: "--label",
  envFile: "--env-file",
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

const listed = (output: string) => {
  const parsed = parseJson(output);

  return Array.isArray(parsed) ? parsed : [];
};

export const volumesOf = (output: string) =>
  listed(output).flatMap((entry) => {
    const volume = record(entry);
    const configuration = record(volume.configuration);
    const name = text(volume.name) ?? text(configuration.name);
    const labels = record(volume.labels ?? configuration.labels) as Record<string, string>;

    return name === undefined ? [] : [{ name, labels }];
  });

const mountedName = (mount: unknown) => text(record(record(record(mount).type).volume).name);

export const mountedVolumesOf = (output: string) =>
  new Set(
    listed(output).flatMap((entry) => {
      const mounts = record(record(entry).configuration).mounts;

      return (Array.isArray(mounts) ? mounts : []).flatMap((mount) => {
        const name = mountedName(mount);

        return name === undefined ? [] : [name];
      });
    }),
  );

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

export const networkNamesOf = (output: string) => {
  const parsed = parseJson(output);

  return (Array.isArray(parsed) ? parsed : []).flatMap((entry) => {
    const name = text(record(entry).id) ?? text(record(record(entry).config).id);

    return name === undefined ? [] : [name];
  });
};

export const networkOf = (output: string): AppleNetwork => {
  const network = firstEntry(parseJson(output));
  const labels = record(firstAt(network, APPLE_NETWORK_FIELDS.labels));

  return {
    gateway: text(firstAt(network, APPLE_NETWORK_FIELDS.gateway)),
    internal: internalOf(network),
    managed: labels[LABELS.managed] === "true",
  };
};
