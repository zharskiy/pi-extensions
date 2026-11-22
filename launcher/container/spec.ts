import { dirname, resolve } from "node:path";
import {
  type ContainerSpec,
  type ImageInfo,
  LABELS,
  type MountSpec,
  type NetworkRef,
  SERVICES_ALIAS,
} from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  GUEST_HOME,
  GUEST_PATHS,
  guestReservedOver,
  isLauncherSetVariable,
  isSecretShapedValue,
  isWithin,
  LauncherError,
  PI_SESSION_DIR_VARIABLE,
  realOrResolvedSync,
} from "../shared/index.ts";
import {
  type GitOverlay,
  gitRepos,
  type HostSessions,
  mountedGitDirs,
  type Workspace,
} from "../workspace/index.ts";
import { containerName } from "./names.ts";
import { type PlannedVolume, repoLabels, serviceVolumeNames, volumePlan } from "./volumes.ts";

export const HANDOVER_CAPABILITIES = ["CHOWN"];

export interface LauncherContainerSpec extends ContainerSpec {
  workdir: string;
  volumeLabels: Record<string, Record<string, string>>;
  ownedPaths: string[];
  guardedPaths: string[];
  notices: string[];
}

interface SpecProxy {
  url: string;
  network: NetworkRef;
}

export interface ContainerSpecInput {
  workspace: Workspace;
  config: SandboxConfig;
  image: ImageInfo;
  stateDir: string;
  launchId: string;
  gitOverlay: GitOverlay;
  proxy: SpecProxy;
  servicePorts: number[];
  renderDir: string;
  hostSessions: HostSessions;
  toolEnv: Record<string, string>;
  binds: GuestBind[];
}

interface GuestBind {
  source: string;
  target: string;
}

const GUEST_CA_BUNDLE = GUEST_PATHS.caBundle;

const SHARED_TMPFS = "mode=1777,exec";

const bind = (source: string, target: string, readOnly: boolean): MountSpec => ({
  source,
  target,
  readOnly,
  kind: "bind",
});

const volume = (source: string, target: string): MountSpec => ({
  source,
  target,
  readOnly: false,
  kind: "volume",
});

const writableRoots = (workspace: Workspace) => {
  const roots = [...new Set(mountedGitDirs(workspace))];

  return roots.filter((path) => !roots.some((other) => other !== path && isWithin(path, other)));
};

const gitCommonDirsOf = (workspace: Workspace) =>
  gitRepos(workspace).flatMap((repo) => (repo.gitCommonDir === undefined ? [] : [repo.gitCommonDir]));

const gitMounts = ({ selfBinds, readOnlyDirs }: GitOverlay) => [
  ...selfBinds.map((path) => bind(path, path, false)),
  ...readOnlyDirs.map((path) => bind(path, path, true)),
];

const depthOver = (mounts: MountSpec[], dir: string) =>
  mounts
    .filter((mount) => isWithin(dir, mount.target))
    .map((mount) => ({ mount, depth: resolve(mount.target).length }));

const isHidden = (mounts: MountSpec[], dir: string) => {
  const over = depthOver(mounts, dir);
  const deepest = Math.max(...over.map((entry) => entry.depth));
  const top = over.filter((entry) => entry.depth === deepest).map((entry) => entry.mount);

  return (
    top.length > 0 &&
    top.every((mount) => mount.kind === "volume" || mount.readOnly) &&
    !mounts.some(
      (mount) =>
        mount.kind !== "volume" &&
        !mount.readOnly &&
        (isWithin(mount.target, dir) || isWithin(mount.source, dir)),
    )
  );
};

const assertOverlaysHidden = (workspace: Workspace, mounts: MountSpec[]) => {
  const exposed = (workspace.overlays ?? []).find((dir) => !isHidden(mounts, dir));

  if (exposed !== undefined) {
    throw new LauncherError(
      `workspace: the sandbox could write in ${exposed}, which the launcher did not search for repositories, refusing`,
      "set mounts.autoOverlays to false so the launcher searches it, or start pi in a narrower folder",
    );
  }
};

const parentsBelow = (root: string, path: string): string[] => {
  const parent = dirname(path);

  return parent === root || !isWithin(parent, root) ? [] : [...parentsBelow(root, parent), parent];
};

const AWAIT_HANDOVER_VARIABLE = "PI_SANDBOX_AWAIT_HANDOVER";

const handoverEnv = (ownedPaths: string[]): Record<string, string> =>
  ownedPaths.length > 0 ? { [AWAIT_HANDOVER_VARIABLE]: "1" } : {};

const forwarderEnv = (ports: number[]): Record<string, string> =>
  ports.length === 0
    ? {}
    : { PI_SANDBOX_SERVICE_PORTS: ports.join(" "), PI_SANDBOX_SERVICES_HOST: SERVICES_ALIAS };

const proxyEnv = (input: ContainerSpecInput): Record<string, string> => {
  const { url } = input.proxy;
  const directHosts = `localhost,127.0.0.1,::1,${new URL(url).hostname}`;

  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: directHosts,
    https_proxy: url,
    http_proxy: url,
    all_proxy: url,
    no_proxy: directHosts,
    NODE_USE_ENV_PROXY: "1",
  };
};

const hostSessionsDirOf = (input: ContainerSpecInput) =>
  "dir" in input.hostSessions ? input.hostSessions.dir : undefined;

const sessionsEnv = (input: ContainerSpecInput): Record<string, string> => {
  const dir = hostSessionsDirOf(input);

  return dir === undefined ? {} : { [PI_SESSION_DIR_VARIABLE]: dir };
};

const sessionsMounts = (input: ContainerSpecInput) => {
  const dir = hostSessionsDirOf(input);

  return dir === undefined ? [] : [bind(realOrResolvedSync(dir), dir, false)];
};

const sessionsLabel = (sessions: HostSessions) => ({
  [LABELS.sessionDir]: "dir" in sessions ? sessions.dir : sessions.off,
});

const sandboxEnv = (input: ContainerSpecInput) => ({
  ...proxyEnv(input),
  ...input.toolEnv,
  ...sessionsEnv(input),
  NODE_EXTRA_CA_CERTS: GUEST_CA_BUNDLE,
  SSL_CERT_FILE: GUEST_CA_BUNDLE,
  CURL_CA_BUNDLE: GUEST_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: GUEST_CA_BUNDLE,
  PIP_CERT: GUEST_CA_BUNDLE,
  CARGO_HTTP_CAINFO: GUEST_CA_BUNDLE,
  GIT_SSL_CAINFO: GUEST_CA_BUNDLE,
  GIT_TERMINAL_PROMPT: "0",
  PI_SANDBOX: "1",
  PI_SANDBOX_STATUS: GUEST_PATHS.statusFile,
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_CLIPBOARD_OSC52: "1",
});

export const forwardedNames = (env: SandboxConfig["env"]) =>
  env.allow.filter((name) => !Object.hasOwn(env.set, name));

export const forwardedEnv = (
  names: string[],
  hostEnv: Record<string, string | undefined>,
  report: (notice: string) => void = () => undefined,
) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = hostEnv[name];

      if (value === undefined || isLauncherSetVariable(name)) {
        return [];
      }

      if (isSecretShapedValue(value)) {
        report(`env.allow: ${name} holds a credential, so it stays on the host`);

        return [];
      }

      return [[name, value]];
    }),
  );

const renderMounts = (renderDir: string) => [
  bind(realOrResolvedSync(renderDir), GUEST_PATHS.renderDir, true),
];

const baseLabels = (input: ContainerSpecInput) => ({
  [LABELS.role]: "agent",
  ...repoLabels(input.workspace.repoRoot),
  [LABELS.launchId]: input.launchId,
  [LABELS.imageDigest]: input.image.digest,
  ...sessionsLabel(input.hostSessions),
});

const guardedPathsOf = (binds: MountSpec[], workspace: Workspace) => [
  ...new Set([
    ...binds.filter((mount) => mount.readOnly).map((mount) => mount.target),
    ...gitCommonDirsOf(workspace),
  ]),
];

const placeVolumes = (planned: PlannedVolume[], guarded: string[]) => {
  const placed = planned.map((entry) => ({
    entry,
    inside:
      entry.key === "mounts.autoOverlays"
        ? guarded.find((target) => isWithin(entry.target, target))
        : undefined,
  }));

  return {
    volumes: placed.flatMap(({ entry, inside }) => (inside === undefined ? [entry] : [])),
    notices: placed.flatMap(({ entry, inside }) =>
      inside === undefined
        ? []
        : [`${entry.target} is not overlaid: it lies inside ${inside}, which the sandbox protects`],
    ),
  };
};

const TABLE_HINT = "start pi in another folder";

const checkMountTable = (mounts: MountSpec[], own: MountSpec[]) => {
  mounts.forEach((mount, index) => {
    const target = resolve(mount.target);
    const reserved = own.includes(mount) ? undefined : guestReservedOver(target);

    if (reserved !== undefined) {
      throw new LauncherError(
        `workspace: the sandbox would mount ${mount.target} over ${reserved}, which the sandbox image needs, refusing`,
        TABLE_HINT,
      );
    }

    if (mounts.slice(0, index).some((other) => resolve(other.target) === target)) {
      throw new LauncherError(
        `workspace: the sandbox would mount ${mount.target} twice, refusing`,
        TABLE_HINT,
      );
    }
  });
};

const overlap = (one: string, other: string) => isWithin(one, other) || isWithin(other, one);

const checkConfigMounts = (configured: MountSpec[], mounts: MountSpec[]) => {
  const clash = configured
    .flatMap((mount) =>
      mounts
        .filter((other) => other !== mount && overlap(mount.target, other.target))
        .map((other) => [mount, other]),
    )
    .at(0);

  if (clash !== undefined) {
    throw new LauncherError(
      `mounts: the sandbox would mount ${clash[0].target} and ${clash[1].target} inside one another, refusing`,
      "move that target in mounts.volumes or mounts.binds",
    );
  }
};

export const buildContainerSpec = (input: ContainerSpecInput): LauncherContainerSpec => {
  const { workspace, config } = input;
  const planned = volumePlan({ workspace, config, stateDir: input.stateDir });
  const binds = [
    ...writableRoots(workspace).map((path) => bind(path, path, false)),
    ...gitMounts(input.gitOverlay),
    ...sessionsMounts(input),
  ];
  const render = renderMounts(input.renderDir);
  const configBinds = input.binds.map((entry) => bind(entry.source, entry.target, true));
  const guardedPaths = guardedPathsOf([...binds, ...render], workspace);
  const { volumes, notices } = placeVolumes(planned, guardedPaths);
  const serviceVolumes = serviceVolumeNames(input.stateDir, config.services);
  const owned = volumes.filter((entry) => entry.key !== "agent" && !serviceVolumes.has(entry.name));
  const toMount = (entry: PlannedVolume) => volume(entry.name, entry.target);
  const configured = [
    ...configBinds,
    ...volumes.filter((entry) => entry.key === "mounts.volumes").map(toMount),
  ];
  const mounts = [
    ...binds,
    ...render,
    ...volumes.filter((entry) => entry.key !== "mounts.volumes").map(toMount),
    ...configured,
  ];

  checkMountTable(mounts, render);

  checkConfigMounts(configured, mounts);

  assertOverlaysHidden(workspace, mounts);

  const ownedPaths = [
    ...new Set([
      ...configured.flatMap((mount) => parentsBelow(GUEST_HOME, mount.target)),
      ...owned.map((entry) => entry.target),
    ]),
  ];

  return {
    name: containerName(workspace.repoRoot, input.launchId),
    image: input.image.id,
    labels: baseLabels(input),
    mounts,
    network: input.proxy.network,
    env: {
      ...config.env.set,
      ...sandboxEnv(input),
      ...handoverEnv(ownedPaths),
      ...forwarderEnv(input.servicePorts),
    },
    workdir: workspace.repoRoot,
    readOnlyRoot: true,
    tmpfs: [`/tmp:${SHARED_TMPFS}`, `${GUEST_HOME}:${SHARED_TMPFS}`],
    init: true,
    resources: {
      cpus: config.resources.cpus,
      memoryGiB: config.resources.memoryGiB,
      pids: config.resources.pids,
      openFiles: config.resources.openFiles,
      shmMiB: config.resources.shmMiB,
    },
    capabilities: HANDOVER_CAPABILITIES,
    autoRemove: true,
    volumeLabels: Object.fromEntries(volumes.map((entry) => [entry.name, entry.labels])),
    ownedPaths,
    guardedPaths,
    notices,
  };
};
