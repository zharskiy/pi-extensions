type Fallback = "refuse" | "host";

export type SecretRef =
  | { env: string }
  | { file: string; pointer: string }
  | { command: string[]; ttlSeconds?: number }
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
  transform?: "urlUserinfoBase64";
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

export type ParentProxy = "env" | "none";

export type ExtraCa = { file: string } | { hostStore: true };

export interface WorkspaceRootsConfig {
  roots: string[];
  outside: "refuse" | "warn";
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
  reference: string;
  digest?: string;
  packages?: string[];
  npmGlobal?: string[];
  dockerfile?: string;
}

interface MountsConfig {
  extraReadOnly: string[];
  cacheVolumes: string[];
  sharedCaches: string[];
  autoNodeModules: boolean;
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
  org?: string;
}

export type LayerName = "policy" | "org" | "user" | "project";

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
  org?: string;
}

export interface EffectiveConfig {
  config: SandboxConfig;
  sources: Record<string, ConfigSource>;
}
