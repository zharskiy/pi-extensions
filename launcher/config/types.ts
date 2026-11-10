import type { ToolConfigFormat } from "../shared/index.ts";

export const FALLBACKS = ["refuse", "host"] as const;

type Fallback = (typeof FALLBACKS)[number];

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

export const PARENT_PROXIES = ["env", "none"] as const;

export type ParentProxy = (typeof PARENT_PROXIES)[number];

export type ExtraCa = { file: string } | { hostStore: true };

interface WorkspaceRootsConfig {
  roots: string[];
}

export type EgressPreset = "npm" | "pypi" | "github" | "maven" | "gradle" | "go" | "cargo";

interface EgressConfig {
  allow: string[];
  presets: EgressPreset[];
  deny: string[];
  privateHosts: string[];
  parentProxy: ParentProxy;
  grants: boolean;
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
  fallback: Fallback;
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

export type LayerName = "policy" | "user";

export type ConfigSource = "default" | LayerName;

export interface LayerConfig {
  fallback?: Fallback;
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

export interface IgnoredKey {
  layer: ConfigSource;
  key: string;
  reason: string;
}

export interface EffectiveConfig {
  config: SandboxConfig;
  sources: Record<string, string>;
  ignored: IgnoredKey[];
}
