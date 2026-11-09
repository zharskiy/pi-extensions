import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ContainerSpec,
  engineSocketPath,
  type ImageInfo,
  type MountSpec,
  type NetworkRef,
} from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  GUEST_PATHS,
  isWithin,
  LAUNCHER_SET_VARIABLES,
  PI_SESSION_DIR_VARIABLE,
  stableHash,
  stateLayout,
} from "../shared/index.ts";
import {
  type GitOverlay,
  gitRepos,
  type HostCache,
  type HostSessions,
  mountedGitDirs,
  resolveExtraMounts,
  type Workspace,
} from "../workspace/index.ts";
import {
  agentVolumeName,
  cacheVolumeName,
  containerName,
  LABELS,
  repoHash,
  sharedVolumeName,
  userHashOf,
} from "./names.ts";

export interface LauncherContainerSpec extends ContainerSpec {
  volumeLabels: Record<string, Record<string, string>>;
  ownedPaths: string[];
}

export interface PathVolume {
  path: string;
  name: string;
}

interface SpecProxy {
  url: string;
  network: NetworkRef;
  tokenHash: string;
  caPemPath?: string;
}

interface SpecTrust {
  pemPath: string;
  hash: string;
}

export interface ContainerSpecInput {
  workspace: Workspace;
  config: SandboxConfig;
  image: ImageInfo & { reference: string };
  hostEnv: Record<string, string | undefined>;
  hostUid: number;
  stateDir: string;
  gitOverlay: GitOverlay;
  proxy?: SpecProxy;
  launcherVersion: string;
  renderDir?: string;
  trust?: SpecTrust;
  launchId?: string;
  hostSessions?: HostSessions;
  toolEnv?: Record<string, string>;
  hostCaches?: HostCache[];
}

export interface RepoVolumesInput {
  workspace: Workspace;
  config: SandboxConfig;
  hostEnv: Record<string, string | undefined>;
  uid: number;
}

const GUEST_HOME = "/home/pi";

const GUEST_CA_BUNDLE = "/tmp/pi-sandbox/ca-bundle.pem";

const SHARED_TMPFS = "mode=1777";

const NO_NETWORK: NetworkRef = { kind: "none" };

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

const REPO_CONFIG_NAMES = new Set(["config", "config.worktree"]);

export const isGitConfigFile = (path: string) => REPO_CONFIG_NAMES.has(basename(path));

const gitMounts = (input: ContainerSpecInput) => {
  const overlay = input.gitOverlay;

  if (gitCommonDirsOf(input.workspace).length === 0) {
    return [];
  }

  const files = stateLayout(input.stateDir).repo(repoHash(input.workspace.repoRoot));
  const fileMount = (target: string) =>
    isGitConfigFile(target) ? bind(files.gitCopy(target), target, true) : bind(target, target, true);

  return [
    ...overlay.selfBinds.map((path) => bind(path, path, false)),
    ...overlay.readOnlyDirs.map((path) => bind(path, path, true)),
    ...overlay.readOnlyFiles.map(fileMount),
  ];
};

const hostUser = (hostEnv: Record<string, string | undefined>, uid: number) =>
  hostEnv.USER ?? hostEnv.LOGNAME ?? String(uid);

const resolvedPath = (repoRoot: string, path: string) => (isAbsolute(path) ? path : resolve(repoRoot, path));

const extraMounts = (input: ContainerSpecInput) => {
  const home = input.hostEnv.HOME ?? homedir();

  return resolveExtraMounts(input.config.mounts.extraReadOnly, {
    home,
    env: input.hostEnv,
    repoRoot: input.workspace.repoRoot,
    engineSockets: [engineSocketPath(home)],
  });
};

const hostCacheMounts = (caches: HostCache[] = []) =>
  caches.map((cache) => bind(cache.source, join(GUEST_HOME, cache.target), false));

const homeRelative = (path: string) => path.slice(2).replace(/\/+$/, "");

const guestHomePath = (path: string) => join(GUEST_HOME, homeRelative(path));

const cacheTargets = (workspace: Workspace, config: SandboxConfig) =>
  config.mounts.cacheVolumes.map((path) => resolvedPath(workspace.repoRoot, path));

export const overlayVolumes = (workspace: Workspace, config: SandboxConfig): PathVolume[] => {
  if (!config.mounts.autoOverlays) {
    return [];
  }

  const covered = cacheTargets(workspace, config);

  return (workspace.overlays ?? [])
    .filter((path) => !covered.some((target) => isWithin(path, target)))
    .map((path) => ({ path, name: cacheVolumeName(workspace.repoRoot, relative(workspace.repoRoot, path)) }));
};

export const sharedCacheVolumes = (config: SandboxConfig, stateDir: string): PathVolume[] => {
  const userHash = userHashOf(stateDir);

  return config.mounts.sharedCaches.map((entry) => {
    const path = `~/${homeRelative(entry)}`;

    return { path, name: sharedVolumeName(userHash, path) };
  });
};

export const repoVolumes = ({ workspace, config, hostEnv, uid }: RepoVolumesInput) => [
  ...new Set([
    agentVolumeName(hostUser(hostEnv, uid), workspace.repoRoot),
    ...config.mounts.cacheVolumes.map((path) => cacheVolumeName(workspace.repoRoot, path)),
    ...overlayVolumes(workspace, config).map((overlay) => overlay.name),
  ]),
];

const parentsBelow = (root: string, path: string): string[] => {
  const parent = dirname(path);

  return parent === root || !isWithin(parent, root) ? [] : [...parentsBelow(root, parent), parent];
};

const repoVolumeLabels = (workspace: Workspace) => ({
  [LABELS.repoHash]: repoHash(workspace.repoRoot),
  [LABELS.repoRoot]: workspace.repoRoot,
});

const cacheVolumeLabels = (workspace: Workspace, target: string) => ({
  ...repoVolumeLabels(workspace),
  [LABELS.cachePath]: relative(workspace.repoRoot, target) || ".",
});

const sharedVolumeLabels = (stateDir: string, path: string) => ({
  [LABELS.userHash]: userHashOf(stateDir),
  [LABELS.sharedPath]: path,
});

const ownedVolumes = (input: ContainerSpecInput) => {
  const { workspace, config } = input;
  const caches = config.mounts.cacheVolumes.map((path) => {
    const target = resolvedPath(workspace.repoRoot, path);

    return {
      name: cacheVolumeName(workspace.repoRoot, path),
      target,
      labels: cacheVolumeLabels(workspace, target),
    };
  });
  const overlays = overlayVolumes(workspace, config).map((overlay) => ({
    name: overlay.name,
    target: overlay.path,
    labels: cacheVolumeLabels(workspace, overlay.path),
  }));
  const shared = sharedCacheVolumes(config, input.stateDir).map((cache) => ({
    name: cache.name,
    target: guestHomePath(cache.path),
    labels: sharedVolumeLabels(input.stateDir, cache.path),
  }));

  return { repo: [...caches, ...overlays], shared };
};

export const forwardedEnv = (names: string[], hostEnv: Record<string, string | undefined>) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = hostEnv[name];

      return value === undefined || LAUNCHER_SET_VARIABLES.includes(name) ? [] : [[name, value]];
    }),
  );

const LOOPBACK_HOSTS = "localhost,127.0.0.1,::1";

const javaProxyOptions = (host: string, port: string, user: string, password: string) =>
  ["https", "http"]
    .flatMap((scheme) => [
      `-D${scheme}.proxyHost=${host}`,
      `-D${scheme}.proxyPort=${port}`,
      `-D${scheme}.proxyUser=${user}`,
      `-D${scheme}.proxyPassword=${password}`,
    ])
    .concat(["-Djdk.http.auth.tunneling.disabledSchemes=", "-Djdk.http.auth.proxying.disabledSchemes="])
    .join(" ");

const proxyEnv = (input: ContainerSpecInput): Record<string, string> => {
  if (input.proxy === undefined) {
    return {};
  }

  const { url } = input.proxy;
  const { hostname, port, username, password } = new URL(url);

  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: LOOPBACK_HOSTS,
    https_proxy: url,
    http_proxy: url,
    all_proxy: url,
    no_proxy: LOOPBACK_HOSTS,
    NODE_USE_ENV_PROXY: "1",
    PI_SANDBOX_PROXY_HOST: hostname,
    PI_SANDBOX_PROXY_PORT: port,
    PI_SANDBOX_PROXY_TOKEN: password,
    JAVA_TOOL_OPTIONS: javaProxyOptions(hostname, port, username, password),
  };
};

const trustSource = (input: ContainerSpecInput) => input.trust?.pemPath ?? input.proxy?.caPemPath;

const trustEnv = (input: ContainerSpecInput): Record<string, string> => ({
  ...(trustSource(input) === undefined ? {} : { NODE_EXTRA_CA_CERTS: GUEST_PATHS.trustPem }),
  ...(input.trust === undefined ? {} : { PI_SANDBOX_TRUST_HASH: input.trust.hash }),
});

const hostSessionsDirOf = (input: ContainerSpecInput) =>
  input.hostSessions !== undefined && "dir" in input.hostSessions ? input.hostSessions.dir : undefined;

const sessionsEnv = (input: ContainerSpecInput): Record<string, string> => {
  const dir = hostSessionsDirOf(input);

  return dir === undefined ? {} : { [PI_SESSION_DIR_VARIABLE]: dir };
};

const sessionsMounts = (input: ContainerSpecInput) => {
  const dir = hostSessionsDirOf(input);

  return dir === undefined ? [] : [bind(dir, dir, false)];
};

const sessionsLabel = (sessions: HostSessions | undefined): Record<string, string> => {
  if (sessions === undefined) {
    return {};
  }

  return { [LABELS.sessionDir]: "dir" in sessions ? sessions.dir : sessions.off };
};

const sandboxEnv = (input: ContainerSpecInput) => ({
  ...proxyEnv(input),
  ...input.toolEnv,
  ...trustEnv(input),
  ...sessionsEnv(input),
  SSL_CERT_FILE: GUEST_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: GUEST_CA_BUNDLE,
  PIP_CERT: GUEST_CA_BUNDLE,
  CARGO_HTTP_CAINFO: GUEST_CA_BUNDLE,
  GIT_SSL_CAINFO: GUEST_CA_BUNDLE,
  GIT_TERMINAL_PROMPT: "0",
  PI_SANDBOX: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_CLIPBOARD_OSC52: "1",
});

const trustMounts = (input: ContainerSpecInput) => {
  const source = trustSource(input);

  return source === undefined ? [] : [bind(source, GUEST_PATHS.trustPem, true)];
};

const renderMounts = (renderDir: string | undefined) =>
  renderDir === undefined ? [] : [bind(renderDir, GUEST_PATHS.renderDir, true)];

const baseLabels = (input: ContainerSpecInput) => ({
  [LABELS.managed]: "true",
  [LABELS.repoHash]: repoHash(input.workspace.repoRoot),
  [LABELS.repoRoot]: input.workspace.repoRoot,
  [LABELS.imageDigest]: input.image.digest,
  [LABELS.imageReference]: input.image.reference,
  [LABELS.version]: input.launcherVersion,
  ...(input.proxy === undefined ? {} : { [LABELS.proxyTokenHash]: input.proxy.tokenHash }),
  ...sessionsLabel(input.hostSessions),
  ...(input.workspace.gitCommonDir === undefined
    ? {}
    : { [LABELS.gitCommonDir]: input.workspace.gitCommonDir }),
  ...(input.workspace.isGitRepo || gitCommonDirsOf(input.workspace).length === 0
    ? {}
    : { [LABELS.gitCommonDirs]: JSON.stringify(gitCommonDirsOf(input.workspace)) }),
});

const SECTION_HASH_LENGTH = 12;

const specSections = ({
  image,
  env,
  mounts,
  labels,
  volumeLabels,
  ownedPaths,
  ...rest
}: LauncherContainerSpec) => ({
  config: {
    ...rest,
    labels: { ...labels, [LABELS.imageDigest]: undefined, [LABELS.proxyTokenHash]: undefined },
  },
  image: { image, digest: labels[LABELS.imageDigest] },
  credentials: { env, token: labels[LABELS.proxyTokenHash] },
  overlays: { volumes: mounts.filter((mount) => mount.kind === "volume"), volumeLabels, ownedPaths },
  mounts: mounts.filter((mount) => mount.kind !== "volume"),
});

const sectionHashes = (spec: LauncherContainerSpec) =>
  Object.fromEntries(
    Object.entries(specSections(spec)).map(([name, part]) => [
      name,
      stableHash(part).slice(0, SECTION_HASH_LENGTH),
    ]),
  );

const withSpecHash = (spec: LauncherContainerSpec): LauncherContainerSpec => ({
  ...spec,
  labels: {
    ...spec.labels,
    [LABELS.specHash]: stableHash(spec),
    [LABELS.specSections]: JSON.stringify(sectionHashes(spec)),
  },
});

export const buildContainerSpec = (input: ContainerSpecInput): LauncherContainerSpec => {
  const { workspace, config } = input;
  const extraReadOnly = extraMounts(input).map((mount) => bind(mount.source, mount.target, true));
  const agentVolume = agentVolumeName(hostUser(input.hostEnv, input.hostUid), workspace.repoRoot);
  const owned = ownedVolumes(input);
  const volumes = [...owned.repo, ...owned.shared];
  const hostCaches = hostCacheMounts(input.hostCaches);

  return withSpecHash({
    name: containerName(workspace.repoRoot),
    image: input.image.id,
    labels: baseLabels(input),
    mounts: [
      ...writableRoots(workspace).map((path) => bind(path, path, false)),
      ...gitMounts(input),
      ...extraReadOnly,
      volume(agentVolume, GUEST_PATHS.agentDir),
      ...sessionsMounts(input),
      ...volumes.map((entry) => volume(entry.name, entry.target)),
      ...hostCaches,
      ...renderMounts(input.renderDir),
      ...trustMounts(input),
    ],
    network: input.proxy?.network ?? NO_NETWORK,
    env: sandboxEnv(input),
    workdir: workspace.repoRoot,
    readOnlyRoot: true,
    tmpfs: [`/tmp:${SHARED_TMPFS}`, `${GUEST_HOME}:${SHARED_TMPFS}`],
    init: true,
    resources: { cpus: config.resources.cpus, memoryGiB: config.resources.memoryGiB },
    volumeLabels: Object.fromEntries([
      [agentVolume, repoVolumeLabels(workspace)],
      ...volumes.map((entry) => [entry.name, entry.labels]),
    ]),
    ownedPaths: [
      ...new Set([
        ...owned.shared.flatMap((entry) => parentsBelow(GUEST_HOME, entry.target)),
        ...hostCaches.flatMap((mount) => parentsBelow(GUEST_HOME, mount.target)),
        ...volumes.map((entry) => entry.target),
      ]),
    ],
  });
};
