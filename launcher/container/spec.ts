import { dirname, resolve } from "node:path";
import {
  type ContainerSpec,
  type ImageInfo,
  LABELS,
  type MountSpec,
  type NetworkRef,
} from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  GUEST_PATHS,
  isLauncherSetVariable,
  isSecretShapedValue,
  isWithin,
  LauncherError,
  PI_SESSION_DIR_VARIABLE,
  realOrResolvedSync,
  repoHash,
} from "../shared/index.ts";
import {
  type GitOverlay,
  gitRepos,
  type HostSessions,
  mountedGitDirs,
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
}

interface SpecTrust {
  pemPath: string;
  hash: string;
}

export interface ContainerSpecInput {
  workspace: Workspace;
  config: SandboxConfig;
  image: ImageInfo & { reference: string };
  hostUid: number;
  stateDir: string;
  launchId: string;
  gitOverlay: GitOverlay;
  proxy: SpecProxy;
  trust: SpecTrust;
  renderDir?: string;
  hostSessions?: HostSessions;
  toolEnv?: Record<string, string>;
}

const GUEST_CA_BUNDLE = "/tmp/pi-sandbox/ca-bundle.pem";

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

const trustEnv = (input: ContainerSpecInput): Record<string, string> => ({
  NODE_EXTRA_CA_CERTS: GUEST_PATHS.trustPem,
  PI_SANDBOX_TRUST_HASH: input.trust.hash,
});

const hostSessionsDirOf = (input: ContainerSpecInput) =>
  input.hostSessions !== undefined && "dir" in input.hostSessions ? input.hostSessions.dir : undefined;

const sessionsEnv = (input: ContainerSpecInput): Record<string, string> => {
  const dir = hostSessionsDirOf(input);

  return dir === undefined ? {} : { [PI_SESSION_DIR_VARIABLE]: dir };
};

const sessionsMounts = (input: ContainerSpecInput) => {
  const dir = hostSessionsDirOf(input);

  return dir === undefined ? [] : [bind(realOrResolvedSync(dir), dir, false)];
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
  CURL_CA_BUNDLE: GUEST_CA_BUNDLE,
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

const trustMounts = (input: ContainerSpecInput) => [
  bind(realOrResolvedSync(input.trust.pemPath), GUEST_PATHS.trustPem, true),
];

const renderMounts = (renderDir: string | undefined) =>
  renderDir === undefined ? [] : [bind(realOrResolvedSync(renderDir), GUEST_PATHS.renderDir, true)];

const baseLabels = (input: ContainerSpecInput) => ({
  [LABELS.managed]: "true",
  [LABELS.repoHash]: repoHash(input.workspace.repoRoot),
  [LABELS.repoRoot]: input.workspace.repoRoot,
  [LABELS.launchId]: input.launchId,
  [LABELS.imageDigest]: input.image.digest,
  [LABELS.imageReference]: input.image.reference,
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

const GUEST_RESERVED = [
  "/usr/local/bin",
  "/usr/local/lib",
  dirname(GUEST_PATHS.renderDir),
  dirname(GUEST_PATHS.trustPem),
  GUEST_HOME,
  "/tmp",
];

const checkMountTable = (mounts: MountSpec[], guestReserved: string[]) => {
  mounts.forEach((mount, index) => {
    const target = resolve(mount.target);
    const reserved = guestReserved.find((path) => isWithin(path, target));

    if (reserved !== undefined) {
      throw new LauncherError(
        `workspace: the sandbox would mount ${mount.target} over ${reserved}, which the sandbox image needs, refusing`,
        "start pi in another folder",
      );
    }

    if (mounts.slice(0, index).some((other) => resolve(other.target) === target)) {
      throw new LauncherError(
        `workspace: the sandbox would mount ${mount.target} twice, refusing`,
        "start pi in another folder",
      );
    }
  });
};

export const buildContainerSpec = (input: ContainerSpecInput): LauncherContainerSpec => {
  const { workspace, config } = input;
  const planned = volumePlan({ workspace, config, uid: input.hostUid, stateDir: input.stateDir });
  const binds = [
    ...writableRoots(workspace).map((path) => bind(path, path, false)),
    ...gitMounts(input.gitOverlay),
    ...sessionsMounts(input),
    ...renderMounts(input.renderDir),
    ...trustMounts(input),
  ];
  const guardedPaths = guardedPathsOf(binds, workspace);
  const { volumes, notices } = placeVolumes(planned, guardedPaths);
  const owned = volumes.filter((entry) => entry.key !== "agent");
  const mounts = [...binds, ...volumes.map((entry) => volume(entry.name, entry.target))];

  checkMountTable(mounts, GUEST_RESERVED);

  assertOverlaysHidden(workspace, mounts);

  const spec: LauncherContainerSpec = {
    name: containerName(workspace.repoRoot, input.launchId),
    image: input.image.id,
    labels: baseLabels(input),
    mounts,
    network: input.proxy.network,
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
        ...owned.map((entry) => entry.target),
      ]),
    ],
    guardedPaths,
  };

  return notices.length === 0 ? spec : { ...spec, notices };
};
