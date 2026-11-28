import type { ToolConfigFormat, ValueSpec } from "../shared/index.ts";

export type FileSecret =
  | { file: string; pointer: string }
  | { file: string; format: ToolConfigFormat; key: string; urlPassword?: true; urlUsername?: true };

export type SecretRef =
  | { env: string; urlPassword?: true; urlUsername?: true }
  | FileSecret
  | { command: string[] }
  | { piAuth: string; bearer?: boolean }
  | { mcpOAuth: { server: string; url: string } };

export interface CredentialRule {
  id: string;
  host: string;
  port?: number;
  pathPrefix?: string;
  placeholder?: string;
  header?: string;
  template?: string;
  secret: SecretRef;
}

export interface DeriveConfig {
  enabled: boolean;
  hosts?: string[];
}

interface CredentialsConfig {
  rules: CredentialRule[];
  derive: DeriveConfig;
}

export type ExtraCa = { file: string } | { sha256: string };

interface EgressConfig {
  allow: string[];
  deny: string[];
  privateHosts: string[];
}

interface ImageConfig {
  reference?: string;
  packages?: string[];
  npmGlobal?: string[];
  dockerfile?: string;
}

interface VmConfig {
  cpus?: number;
  memoryGiB?: number;
  diskGiB?: number;
  releaseFileCache: boolean;
}

export interface VolumeEntry {
  target: string;
  name?: string;
  source?: string;
}

interface BindEntry {
  source: string;
  target: string;
}

interface MountsConfig {
  volumes: Array<string | VolumeEntry>;
  binds: BindEntry[];
}

interface ResourcesConfig {
  cpus?: number;
  memoryGiB?: number;
  pids: number;
  openFiles?: number;
  shmMiB?: number;
}

interface EnvConfig {
  allow: string[];
  set: Record<string, string>;
}

export interface WriteBackConfig {
  enabled: boolean;
  exclude: Record<string, string[]>;
  add: Record<string, Record<string, ValueSpec>>;
}

interface ServiceVolume {
  name: string;
  target: string;
}

interface ServiceReady {
  command: string[];
  timeoutSeconds?: number;
}

export interface ServiceEntry {
  name: string;
  image?: string;
  command: string[];
  user?: string;
  env?: Record<string, string>;
  volumes?: ServiceVolume[];
  tmpfs?: string[];
  ready?: ServiceReady;
  memoryGiB?: number;
  shmMiB?: number;
  ports?: number[];
}

export interface SandboxConfig {
  image: ImageConfig;
  credentials: CredentialsConfig;
  egress: EgressConfig;
  tls: { extraCa: ExtraCa[] };
  workspaceRoot?: string;
  mounts: MountsConfig;
  env: EnvConfig;
  resources: ResourcesConfig;
  vm: VmConfig;
  sessions: { host: boolean };
  terminal: { clipboard: boolean };
  writeBack: WriteBackConfig;
  setup: string[][];
  services: ServiceEntry[];
}

export interface UserConfig {
  image?: Partial<ImageConfig>;
  credentials?: {
    rules?: CredentialRule[];
    derive?: Partial<DeriveConfig>;
  };
  egress?: Partial<EgressConfig>;
  tls?: Partial<SandboxConfig["tls"]>;
  workspaceRoot?: string;
  mounts?: Partial<SandboxConfig["mounts"]>;
  env?: Partial<SandboxConfig["env"]>;
  resources?: Partial<ResourcesConfig>;
  vm?: Partial<VmConfig>;
  sessions?: Partial<SandboxConfig["sessions"]>;
  terminal?: Partial<SandboxConfig["terminal"]>;
  writeBack?: Partial<WriteBackConfig>;
  setup?: string[][];
  services?: ServiceEntry[];
}

export interface EffectiveConfig {
  config: SandboxConfig;
  sources: Record<string, ConfigSource>;
}

export type ConfigSource = "default" | "config" | "default+config";
