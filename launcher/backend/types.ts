export interface MountSpec {
  source: string;
  target: string;
  readOnly: boolean;
  kind: "bind" | "volume";
}

export type NetworkRef =
  | { kind: "none" }
  | { kind: "internal"; name: string; alias?: string }
  | { kind: "container"; id: string };

interface ContainerResources {
  cpus?: number;
  memoryGiB?: number;
  pids: number;
  openFiles?: number;
  shmMiB?: number;
}

export interface ContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  mounts: MountSpec[];
  network: NetworkRef;
  env: Record<string, string>;
  workdir?: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  init: boolean;
  resources: ContainerResources;
  user?: string;
  entrypoint?: string[];
  command?: string[];
  capabilities: string[];
  autoRemove: boolean;
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

export interface ContainerInspect {
  id: string;
  labels: Record<string, string>;
  state: ContainerState;
  exitCode?: number;
}

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
  signal?: AbortSignal;
}

export interface Detection {
  available: boolean;
  reason?: string;
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

export interface RelayRequest {
  hostPort: number;
  imageId: string;
  preamble: string;
}

export interface VmPath {
  path: string;
  writable: boolean;
}

export interface VmShare {
  location: string;
  writable: boolean;
  mountPoint?: string;
}

export interface VmCoverage {
  shares: VmShare[];
  missing: string[];
}

export interface VmSpec {
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
}

export type VmTarget = Partial<VmSpec>;

export type VmSize = Omit<VmSpec, "diskGiB"> & Pick<VmTarget, "diskGiB">;

export interface VmDesired {
  size: VmSpec;
  shares: VmShare[];
}

export type VmInspect =
  | { state: "absent" }
  | { state: "stopped" | "running"; size: VmSpec; shares: VmShare[] | "unreadable" };

export type VmApplied = "created" | "restarted" | "unchanged" | "stopped" | { deferred: number };

export type VmPhase = "creating" | "stopping" | "starting" | "waiting";

export interface VmBusy {
  count: number;
  others: string[];
}

export interface VmApplyOptions {
  busy: () => Promise<VmBusy>;
  progress: (phase: VmPhase) => void;
}

type VmStop = "absent" | "already stopped" | "stopped";

export type VmReport = (notice: string) => void;

export interface VmShareOptions {
  busy: () => Promise<VmBusy>;
  report: VmReport;
}

export interface VmReconcile {
  size: VmTarget;
  shares: VmShare[];
  needs: VmPath[];
}

export interface VmWatch {
  stop(): Promise<void>;
}

type VmOpenFiles = number | "timed out";

export type VmFileCache =
  | { state: "no-vm"; looked: string[] }
  | { state: "lookup-failed"; looked: string[] }
  | { state: "no-limit"; count: VmOpenFiles }
  | { state: "counted"; count: VmOpenFiles; limit: number; maxFiles: number };

export interface Vm {
  watchFileCache?(): VmWatch;
  readFileCache?(): Promise<VmFileCache>;
  ensureRunning(report: VmReport, shares: VmShare[], size?: VmTarget): Promise<void>;
  coverage(paths: VmPath[]): Promise<VmCoverage | "unreadable" | undefined>;
  reconcile(wanted: VmReconcile, options: VmShareOptions): Promise<void>;
  ensureTrust(pemPath: string, options: VmShareOptions): Promise<void>;
  inspect(): Promise<VmInspect>;
  apply(desired: VmDesired, options: VmApplyOptions): Promise<VmApplied>;
  size(): Promise<VmSize | undefined>;
  stop(options: Pick<VmShareOptions, "busy">): Promise<VmStop>;
}

export interface BuildOptions {
  args?: Record<string, string>;
  progress?: (step: string) => void;
  offline?: boolean;
}

export interface Backend {
  vm: Vm;
  detect(): Promise<Detection>;
  pullImage(reference: string, digest?: string): Promise<ImageInfo>;
  resolveImage(reference: string): Promise<ImageInfo | undefined>;
  buildImage(contextDir: string, tag: string, options?: BuildOptions): Promise<ImageInfo>;
  listImages(): Promise<ImageSummary[]>;
  removeImage(reference: string): Promise<boolean>;
  findContainers(labels: Record<string, string>): Promise<ContainerSummary[]>;
  listOtherInstallSessions(): Promise<ContainerSummary[]>;
  createContainer(spec: ContainerSpec): Promise<{ id: string }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(id: string): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInspect | undefined>;
  containerLogs(id: string, lines: number): Promise<string>;
  exec(spec: ExecSpec, io: ExecIo): Promise<number>;
  ensureVolume(name: string, labels?: Record<string, string>): Promise<void>;
  listVolumes(): Promise<VolumeSummary[]>;
  removeVolume(name: string): Promise<void>;
  prepareRelay(request: RelayRequest): Promise<string>;
  prepareNetwork(): Promise<string>;
  removeNetwork(): Promise<boolean>;
  status(): Promise<Record<string, string>>;
}
