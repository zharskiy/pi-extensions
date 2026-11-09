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

export interface NetworkSummary {
  name: string;
  labels: Record<string, string>;
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

export interface ImageSummary {
  id: string;
  tags: string[];
  labels: Record<string, string>;
  inUse: boolean;
  created: number;
}

export interface ProxyRoute {
  network: NetworkRef;
  address: string;
  notices?: string[];
}

export interface ProxyRouteRequest {
  hostPort: number;
  repoHash: string;
  imageId: string;
}

export interface VmPath {
  path: string;
  writable: boolean;
}

export interface VmShare {
  location: string;
  writable: boolean;
}

export interface VmCoverage {
  shares: VmShare[];
  missing: string[];
}

export interface VmSize {
  cpus: number;
  memoryGiB: number;
}

type VmStop = "absent" | "already stopped" | "stopped";

export type VmReport = (notice: string) => void;

export interface VmShareOptions {
  busy: () => Promise<number>;
  report: VmReport;
}

export interface Vm {
  ensureRunning(report: VmReport): Promise<void>;
  coverage(paths: VmPath[]): Promise<VmCoverage | undefined>;
  ensureShares(paths: VmPath[], options: VmShareOptions): Promise<void>;
  size(): Promise<VmSize | undefined>;
  recommendedSize(cpus: number, memGiB: number): VmSize;
  stop(options: Pick<VmShareOptions, "busy">): Promise<VmStop>;
}

export interface Backend {
  vm: Vm;
  detect(): Promise<Detection>;
  pullImage(reference: string, digest?: string): Promise<ImageInfo>;
  resolveImage(reference: string): Promise<ImageInfo | undefined>;
  buildImage(contextDir: string, tag: string, buildArgs?: Record<string, string>): Promise<ImageInfo>;
  listImages(): Promise<ImageSummary[]>;
  removeImage(reference: string): Promise<boolean>;
  findContainers(labels: Record<string, string>): Promise<ContainerSummary[]>;
  createContainer(spec: ContainerSpec): Promise<{ id: string }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  waitRemoved(id: string, timeoutMs: number): Promise<void>;
  removeContainer(id: string): Promise<void>;
  exec(spec: ExecSpec, io: ExecIo): Promise<number>;
  ensureVolume(name: string, labels?: Record<string, string>): Promise<void>;
  listVolumes(): Promise<VolumeSummary[]>;
  removeVolume(name: string): Promise<void>;
  prepareProxyRoute(request: ProxyRouteRequest): Promise<ProxyRoute>;
  listNetworks(): Promise<NetworkSummary[]>;
  removeRepoNetwork(repoHash: string): Promise<boolean>;
  status(): Promise<Record<string, string>>;
}
