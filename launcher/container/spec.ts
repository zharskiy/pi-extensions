import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  type BackendCapabilities,
  type ContainerSpec,
  type ImageInfo,
  type MountSpec,
  type NetworkRef,
  resolveDockerSocket,
} from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  GUEST_PATHS,
  isWithin,
  LAUNCHER_SET_VARIABLES,
  PI_SESSION_DIR_VARIABLE,
  stableHash,
} from "../shared/index.ts";
import { type HostSessions, resolveExtraMounts, type Workspace } from "../workspace/index.ts";
import type { GitOverlay } from "./git-overlay.ts";
import { gitSnapshotPath, gitSnapshotsDir } from "./git-snapshot.ts";
import { agentVolumeName, cacheVolumeName, containerName, copiesDir, LABELS, repoHash } from "./names.ts";

export interface RequiredCopy {
  source: string;
  target: string;
}

export interface LauncherContainerSpec extends ContainerSpec {
  requiredCopies: RequiredCopy[];
  copiesDir: string;
}

interface SpecProxy {
  url: string;
  network: NetworkRef;
  policyHash: string;
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
  hostGid: number;
  platform: NodeJS.Platform;
  capabilities: BackendCapabilities;
  stateDir: string;
  gitOverlay?: GitOverlay;
  proxy?: SpecProxy;
  launcherVersion: string;
  configHash: string;
  renderDir?: string;
  trust?: SpecTrust;
  repoProxyToken?: string;
  launchId?: string;
  hostSessions?: HostSessions;
}

export interface RepoVolumesInput {
  workspace: Workspace;
  config: SandboxConfig;
  hostEnv: Record<string, string | undefined>;
  uid: number;
}

const GUEST_HOME = "/home/pi";

const GUEST_CA_BUNDLE = "/tmp/pi-sandbox/ca-bundle.pem";

const GUEST_SSH_AUTH_SOCK = "/run/host-ssh-agent.sock";

const SHARED_TMPFS = "mode=1777";

const NO_NETWORK: NetworkRef = { kind: "none" };

const GIT_PROTECTION = "snapshots";

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
  const roots = [
    ...new Set([workspace.repoRoot, workspace.gitCommonDir].filter((path) => path !== undefined)),
  ];

  return roots.filter((path) => !roots.some((other) => other !== path && isWithin(path, other)));
};

const gitMounts = (input: ContainerSpecInput) => {
  const overlay = input.gitOverlay;

  if (overlay === undefined || input.workspace.gitCommonDir === undefined) {
    return [];
  }

  const snapshots = gitSnapshotsDir(input.stateDir, input.workspace.repoRoot);
  const snapshotOf = (target: string) => bind(gitSnapshotPath(snapshots, target), target, true);
  const files = input.capabilities.singleFileMount ? overlay.readOnlyFiles : [];

  return [
    ...overlay.selfBinds.map((path) => bind(path, path, false)),
    ...overlay.readOnlyDirs.map(snapshotOf),
    ...files.map(snapshotOf),
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
    engineSockets: [resolveDockerSocket({ env: input.hostEnv, home })],
  });
};

export const repoVolumes = ({ workspace, config, hostEnv, uid }: RepoVolumesInput) => [
  agentVolumeName(hostUser(hostEnv, uid), workspace.repoRoot),
  ...config.mounts.cacheVolumes.map((path) => cacheVolumeName(workspace.repoRoot, path)),
];

export const forwardedEnv = (names: string[], hostEnv: Record<string, string | undefined>) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = hostEnv[name];

      return value === undefined || LAUNCHER_SET_VARIABLES.includes(name) ? [] : [[name, value]];
    }),
  );

const withRepoToken = (url: string, token: string | undefined) => {
  if (token === undefined) {
    return url;
  }

  const parsed = new URL(url);

  return `${parsed.protocol}//${parsed.username}:${token}@${parsed.host}`;
};

const proxyEnv = (input: ContainerSpecInput): Record<string, string> => {
  if (input.proxy === undefined) {
    return {};
  }

  const url = withRepoToken(input.proxy.url, input.repoProxyToken);

  return { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, NO_PROXY: "", NODE_USE_ENV_PROXY: "1" };
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
  ...trustEnv(input),
  ...sessionsEnv(input),
  SSL_CERT_FILE: GUEST_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: GUEST_CA_BUNDLE,
  GIT_SSL_CAINFO: GUEST_CA_BUNDLE,
  PI_SANDBOX: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_CLIPBOARD_OSC52: "1",
});

const trustMounts = (input: ContainerSpecInput) => {
  const source = trustSource(input);

  if (source === undefined) {
    return { mounts: [], copies: [] };
  }

  return input.capabilities.singleFileMount
    ? { mounts: [bind(source, GUEST_PATHS.trustPem, true)], copies: [] }
    : { mounts: [], copies: [{ source, target: GUEST_PATHS.trustPem }] };
};

const renderMounts = (renderDir: string | undefined) =>
  renderDir === undefined ? [] : [bind(renderDir, GUEST_PATHS.renderDir, true)];

const sshAgentOf = (input: ContainerSpecInput) =>
  input.config.ssh.agent && input.capabilities.sshAgent ? { guestSocket: GUEST_SSH_AUTH_SOCK } : undefined;

const baseLabels = (input: ContainerSpecInput) => ({
  [LABELS.managed]: "true",
  [LABELS.repoHash]: repoHash(input.workspace.repoRoot),
  [LABELS.repoRoot]: input.workspace.repoRoot,
  [LABELS.imageDigest]: input.image.digest,
  [LABELS.imageReference]: input.image.reference,
  [LABELS.configHash]: input.configHash,
  [LABELS.version]: input.launcherVersion,
  ...(input.proxy === undefined ? {} : { [LABELS.proxyPolicyHash]: input.proxy.policyHash }),
  ...sessionsLabel(input.hostSessions),
  ...(input.gitOverlay === undefined ? {} : { [LABELS.gitProtection]: GIT_PROTECTION }),
  ...(input.workspace.gitCommonDir === undefined
    ? {}
    : { [LABELS.gitCommonDir]: input.workspace.gitCommonDir }),
});

const withSpecHash = (spec: LauncherContainerSpec): LauncherContainerSpec => ({
  ...spec,
  labels: { ...spec.labels, [LABELS.specHash]: stableHash(spec) },
});

export const buildContainerSpec = (input: ContainerSpecInput): LauncherContainerSpec => {
  const { workspace, config } = input;
  const trust = trustMounts(input);
  const extraReadOnly = extraMounts(input).map((mount) => bind(mount.source, mount.target, true));
  const agentVolume = agentVolumeName(hostUser(input.hostEnv, input.hostUid), workspace.repoRoot);
  const caches = config.mounts.cacheVolumes.map((path) =>
    volume(cacheVolumeName(workspace.repoRoot, path), resolvedPath(workspace.repoRoot, path)),
  );

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
      ...caches,
      ...renderMounts(input.renderDir),
      ...trust.mounts,
    ],
    network: input.proxy?.network ?? NO_NETWORK,
    env: sandboxEnv(input),
    workdir: workspace.repoRoot,
    user: input.platform === "linux" ? `${input.hostUid}:${input.hostGid}` : undefined,
    readOnlyRoot: true,
    tmpfs: [`/tmp:${SHARED_TMPFS}`, `${GUEST_HOME}:${SHARED_TMPFS}`],
    init: true,
    resources: { cpus: config.resources.cpus, memoryGiB: config.resources.memoryGiB },
    sshAgent: sshAgentOf(input),
    requiredCopies: trust.copies,
    copiesDir: copiesDir(input.stateDir, workspace.repoRoot),
  });
};
