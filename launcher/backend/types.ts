export interface MountSpec {
  source: string;
  target: string;
  readOnly: boolean;
  kind: "bind" | "volume";
}

export type NetworkRef = { kind: "none" } | { kind: "internal"; name: string };

interface ContainerResources {
  cpus?: number;
  memoryGiB?: number;
}

export interface ContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  mounts: MountSpec[];
  network: NetworkRef;
  env: Record<string, string>;
  workdir: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  init: true;
  resources: ContainerResources;
  sshAgent?: { guestSocket: string };
}

export interface RemoveContainerOptions {
  keepNetwork?: boolean;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface ExecSpec {
  containerId: string;
  command: string[];
  env: Record<string, string>;
  workdir: string;
  user?: string;
}

export type ContainerState = "running" | "stopped" | "created" | "unknown";

export interface ContainerSummary {
  id: string;
  name: string;
  labels: Record<string, string>;
  state: ContainerState;
  image: string;
}

export interface VolumeSummary {
  name: string;
  labels: Record<string, string>;
  inUse: boolean;
}

export interface ExecIo {
  stdin?: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  tty: boolean;
  size?: TerminalSize;
  onResize?: (listener: (size: TerminalSize) => void) => () => void;
}

export interface Detection {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface ImageInfo {
  id: string;
  digest: string;
}

export interface ProxyRoute {
  network: NetworkRef;
  address: string;
  notices?: string[];
}

export interface ProxyRouteRequest {
  hostPort: number;
  repoHash: string;
  relay: { policyHash: string; imageId: string };
}

export interface Backend {
  detect(): Promise<Detection>;
  pullImage(reference: string, digest?: string): Promise<ImageInfo>;
  resolveImage(reference: string): Promise<ImageInfo | undefined>;
  buildImage(contextDir: string, tag: string, buildArgs?: Record<string, string>): Promise<ImageInfo>;
  findContainers(labels: Record<string, string>): Promise<ContainerSummary[]>;
  createContainer(spec: ContainerSpec): Promise<{ id: string }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(id: string, options?: RemoveContainerOptions): Promise<void>;
  exec(spec: ExecSpec, io: ExecIo): Promise<number>;
  ensureVolume(name: string, labels?: Record<string, string>): Promise<void>;
  listVolumes(): Promise<VolumeSummary[]>;
  removeVolume(name: string): Promise<void>;
  prepareProxyRoute(request: ProxyRouteRequest): Promise<ProxyRoute>;
  pruneNetworks(keepRepoHashes: string[]): Promise<string[]>;
  status(): Promise<Record<string, string>>;
}
