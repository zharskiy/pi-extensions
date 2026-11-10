import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type ContainerSpec,
  engineSocketPath,
  type ImageInfo,
  LABELS,
  type MountSpec,
  type NetworkRef,
} from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  GUEST_PATHS,
  isLauncherSetVariable,
  isWithin,
  LauncherError,
  PI_SESSION_DIR_VARIABLE,
  repoHash,
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
import { containerName } from "./names.ts";
import { GUEST_HOME, type PlannedVolume, volumePlan } from "./volumes.ts";

export interface LauncherContainerSpec extends ContainerSpec {
  volumeLabels: Record<string, Record<string, string>>;
  ownedPaths: string[];
  guardedPaths?: string[];
  notices?: string[];
}

interface SpecProxy {
  url: string;
  network: NetworkRef;
  tokenHash: string;
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
  hostSessions?: HostSessions;
  toolEnv?: Record<string, string>;
  hostCaches?: HostCache[];
}

const GUEST_CA_BUNDLE = "/tmp/pi-sandbox/ca-bundle.pem";

const SHARED_TMPFS = "mode=1777,exec";

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

  const files = stateLayout(input.stateDir).repo(repoHash(input.workspace.repoRoot));
  const fileMount = (target: string) =>
    isGitConfigFile(target) ? bind(files.gitCopy(target), target, true) : bind(target, target, true);

  return [
    ...overlay.selfBinds.map((path) => bind(path, path, false)),
    ...overlay.readOnlyDirs.map((path) => bind(path, path, true)),
    ...overlay.readOnlyFiles.map(fileMount),
  ];
};

const maskMounts = (input: ContainerSpecInput) =>
  (input.workspace.masked ?? []).map((path) => bind(stateLayout(input.stateDir).emptyDir, path, true));

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

const unhiddenRefusal = (dir: string, masked: boolean) =>
  new LauncherError(
    `workspace: the sandbox could write in ${dir}, which the launcher did not search for repositories, refusing`,
    masked
      ? `make ${dir} readable, or start pi in a narrower folder`
      : "set mounts.autoOverlays to false so the launcher searches it, or start pi in a narrower folder",
  );

const assertUnsearchedHidden = (workspace: Workspace, mounts: MountSpec[]) => {
  const exposed = [
    ...(workspace.overlays ?? []).map((dir) => ({ dir, masked: false })),
    ...(workspace.masked ?? []).map((dir) => ({ dir, masked: true })),
  ].find((entry) => !isHidden(mounts, entry.dir));

  if (exposed !== undefined) {
    throw unhiddenRefusal(exposed.dir, exposed.masked);
  }
};

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

const parentsBelow = (root: string, path: string): string[] => {
  const parent = dirname(path);

  return parent === root || !isWithin(parent, root) ? [] : [...parentsBelow(root, parent), parent];
};

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

const trustEnv = (input: ContainerSpecInput): Record<string, string> =>
  input.trust === undefined
    ? {}
    : { NODE_EXTRA_CA_CERTS: GUEST_PATHS.trustPem, PI_SANDBOX_TRUST_HASH: input.trust.hash };

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

export const forwardedEnv = (names: string[], hostEnv: Record<string, string | undefined>) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = hostEnv[name];

      return value === undefined || isLauncherSetVariable(name) ? [] : [[name, value]];
    }),
  );

const trustMounts = (input: ContainerSpecInput) =>
  input.trust === undefined ? [] : [bind(input.trust.pemPath, GUEST_PATHS.trustPem, true)];

const renderMounts = (renderDir: string | undefined) =>
  renderDir === undefined ? [] : [bind(renderDir, GUEST_PATHS.renderDir, true)];

const baseLabels = (input: ContainerSpecInput) => {
  const gitCommonDirs = gitCommonDirsOf(input.workspace);

  return {
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
    ...(input.workspace.isGitRepo || gitCommonDirs.length === 0
      ? {}
      : { [LABELS.gitCommonDirs]: JSON.stringify(gitCommonDirs) }),
  };
};

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

const PROTECTED_TARGET_HINT = "choose a path outside the git dirs and the read-only mounts";

const guardedPathsOf = (binds: MountSpec[], workspace: Workspace) => [
  ...new Set([
    ...binds.filter((mount) => mount.readOnly).map((mount) => mount.target),
    ...gitCommonDirsOf(workspace),
  ]),
];

const guardOf = (guarded: string[]) => (entry: PlannedVolume) =>
  guarded.find((target) => isWithin(entry.target, target));

const assertCacheTargets = (volumes: PlannedVolume[], guarded: string[]) => {
  const insideOf = guardOf(guarded);

  volumes
    .filter((entry) => entry.key !== "mounts.autoOverlays")
    .forEach((entry) => {
      const inside = insideOf(entry);

      if (inside !== undefined) {
        throw new LauncherError(
          `${entry.key}: ${entry.target} lies inside ${inside}, which the sandbox protects`,
          PROTECTED_TARGET_HINT,
        );
      }
    });
};

const droppedOverlays = (volumes: PlannedVolume[], guarded: string[]) => {
  const insideOf = guardOf(guarded);

  return volumes.flatMap((entry) => {
    const inside = entry.key === "mounts.autoOverlays" ? insideOf(entry) : undefined;

    return inside === undefined ? [] : [{ entry, inside }];
  });
};

const overlayNotice = ({ entry, inside }: { entry: PlannedVolume; inside: string }) =>
  `${entry.target} is not overlaid: it lies inside ${inside}, which the sandbox protects`;

export const buildContainerSpec = (input: ContainerSpecInput): LauncherContainerSpec => {
  const { workspace, config } = input;
  const planned = volumePlan({ workspace, config, uid: input.hostUid, stateDir: input.stateDir });
  const hostCaches = hostCacheMounts(input.hostCaches);
  const binds = [
    ...writableRoots(workspace).map((path) => bind(path, path, false)),
    ...gitMounts(input),
    ...maskMounts(input),
    ...extraMounts(input).map((mount) => bind(mount.source, mount.target, true)),
    ...sessionsMounts(input),
    ...hostCaches,
    ...renderMounts(input.renderDir),
    ...trustMounts(input),
  ];
  const guardedPaths = guardedPathsOf(binds, workspace);
  const dropped = droppedOverlays(planned, guardedPaths);
  const volumes = planned.filter((entry) => !dropped.some((drop) => drop.entry === entry));
  const owned = volumes.filter((entry) => entry.key !== "agent");

  assertCacheTargets(owned, guardedPaths);

  const mounts = [...binds, ...volumes.map((entry) => volume(entry.name, entry.target))];

  assertUnsearchedHidden(workspace, mounts);

  const spec = withSpecHash({
    name: containerName(workspace.repoRoot),
    image: input.image.id,
    labels: baseLabels(input),
    mounts,
    network: input.proxy?.network ?? NO_NETWORK,
    env: sandboxEnv(input),
    workdir: workspace.repoRoot,
    readOnlyRoot: true,
    tmpfs: [`/tmp:${SHARED_TMPFS}`, `${GUEST_HOME}:${SHARED_TMPFS}`],
    init: true,
    resources: { cpus: config.resources.cpus, memoryGiB: config.resources.memoryGiB },
    volumeLabels: Object.fromEntries(volumes.map((entry) => [entry.name, entry.labels])),
    ownedPaths: [
      ...new Set([
        ...owned
          .filter((entry) => entry.key === "mounts.sharedCaches")
          .flatMap((entry) => parentsBelow(GUEST_HOME, entry.target)),
        ...hostCaches.flatMap((mount) => parentsBelow(GUEST_HOME, mount.target)),
        ...owned.map((entry) => entry.target),
      ]),
    ],
    guardedPaths,
  });

  return dropped.length === 0 ? spec : { ...spec, notices: dropped.map(overlayNotice) };
};
