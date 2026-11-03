import { isAbsolute, join, resolve } from "node:path";
import type {
  BackendCapabilities,
  ContainerSpec,
  ImageInfo,
  MountSpec,
  NetworkRef,
} from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { isWithin, stableHash } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import type { GitOverlay } from "./git-overlay.ts";
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
}

export interface RepoVolumesInput {
  workspace: Workspace;
  config: SandboxConfig;
  hostEnv: Record<string, string | undefined>;
  uid: number;
}

const GUEST_HOME = "/home/pi";

const GUEST_AGENT_DIR = "/home/pi/.pi/agent";

const GUEST_CA_PATH = "/etc/pi-sandbox/ca.pem";

const GUEST_CA_BUNDLE = "/tmp/pi-sandbox/ca-bundle.pem";

const GUEST_SSH_AUTH_SOCK = "/run/host-ssh-agent.sock";

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
  const roots = [
    ...new Set([workspace.repoRoot, workspace.gitCommonDir].filter((path) => path !== undefined)),
  ];

  return roots.filter((path) => !roots.some((other) => other !== path && isWithin(path, other)));
};

const readOnlyOverlay = (input: ContainerSpecInput) => {
  const gitCommonDir = input.workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return { mounts: [], copies: [] };
  }

  const extra = input.gitOverlay ?? { dirs: [], files: [] };
  const dirs = [...new Set([join(gitCommonDir, "hooks"), ...extra.dirs])];
  const files = [...new Set([join(gitCommonDir, "config"), ...extra.files])];
  const singleFile = input.capabilities.singleFileMount;

  return {
    mounts: [
      ...dirs.map((path) => bind(path, path, true)),
      ...(singleFile ? files.map((path) => bind(path, path, true)) : []),
    ],
    copies: singleFile ? [] : files.map((path) => ({ source: path, target: path })),
  };
};

const hostUser = (hostEnv: Record<string, string | undefined>, uid: number) =>
  hostEnv.USER ?? hostEnv.LOGNAME ?? String(uid);

const resolvedPath = (repoRoot: string, path: string) => (isAbsolute(path) ? path : resolve(repoRoot, path));

export const repoVolumes = ({ workspace, config, hostEnv, uid }: RepoVolumesInput) => [
  agentVolumeName(hostUser(hostEnv, uid), workspace.repoRoot),
  ...config.mounts.cacheVolumes.map((path) => cacheVolumeName(workspace.repoRoot, path)),
];

export const forwardedEnv = (names: string[], hostEnv: Record<string, string | undefined>) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = hostEnv[name];

      return value === undefined ? [] : [[name, value]];
    }),
  );

const proxyEnv = (proxy: SpecProxy | undefined) => {
  if (proxy === undefined) {
    return {};
  }

  return {
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
    NO_PROXY: "",
    NODE_USE_ENV_PROXY: "1",
    ...(proxy.caPemPath === undefined ? {} : { NODE_EXTRA_CA_CERTS: GUEST_CA_PATH }),
  };
};

const sandboxEnv = (input: ContainerSpecInput) => ({
  ...proxyEnv(input.proxy),
  SSL_CERT_FILE: GUEST_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: GUEST_CA_BUNDLE,
  GIT_SSL_CAINFO: GUEST_CA_BUNDLE,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_CLIPBOARD_OSC52: "1",
});

const caMounts = (proxy: SpecProxy | undefined) =>
  proxy?.caPemPath === undefined ? [] : [bind(proxy.caPemPath, GUEST_CA_PATH, true)];

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
});

const withSpecHash = (spec: LauncherContainerSpec): LauncherContainerSpec => ({
  ...spec,
  labels: { ...spec.labels, [LABELS.specHash]: stableHash(spec) },
});

export const buildContainerSpec = (input: ContainerSpecInput): LauncherContainerSpec => {
  const { workspace, config } = input;
  const overlay = readOnlyOverlay(input);
  const extraReadOnly = config.mounts.extraReadOnly.map((path) => {
    const absolute = resolvedPath(workspace.repoRoot, path);

    return bind(absolute, absolute, true);
  });
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
      ...overlay.mounts,
      ...extraReadOnly,
      volume(agentVolume, GUEST_AGENT_DIR),
      ...caches,
      ...caMounts(input.proxy),
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
    requiredCopies: overlay.copies,
    copiesDir: copiesDir(input.stateDir, workspace.repoRoot),
  });
};
