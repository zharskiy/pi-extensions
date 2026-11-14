import type { ToolConfigFormat } from "../shared/index.ts";

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

interface WorkspaceRootsConfig {
  roots: string[];
}

interface EgressConfig {
  allow: string[];
  deny: string[];
  privateHosts: string[];
}

interface ImageConfig {
  reference?: string;
  digest?: string;
  packages?: string[];
  npmGlobal?: string[];
  dockerfile?: string;
}

interface MountsConfig {
  sharedCaches: string[];
  autoOverlays: boolean;
}

export interface SandboxConfig {
  image: ImageConfig;
  credentials: CredentialsConfig;
  egress: EgressConfig;
  tls: { extraCa: ExtraCa[] };
  workspaceRoots?: WorkspaceRootsConfig;
  mounts: MountsConfig;
  env: { allow: string[] };
  resources: { cpus?: number; memoryGiB?: number };
  sessions: { host: boolean };
}

export interface UserConfig {
  image?: Partial<ImageConfig>;
  credentials?: {
    rules?: CredentialRule[];
    derive?: Partial<DeriveConfig>;
  };
  egress?: Partial<EgressConfig>;
  tls?: Partial<SandboxConfig["tls"]>;
  workspaceRoots?: WorkspaceRootsConfig;
  mounts?: Partial<SandboxConfig["mounts"]>;
  env?: Partial<SandboxConfig["env"]>;
  resources?: SandboxConfig["resources"];
  sessions?: Partial<SandboxConfig["sessions"]>;
}

export interface EffectiveConfig {
  config: SandboxConfig;
  sources: Record<string, ConfigSource>;
}

export type ConfigSource = "default" | "config" | "default+config";
