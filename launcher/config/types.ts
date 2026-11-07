import type { BackendName } from "../shared/index.ts";

type Backend = "auto" | BackendName;

type Fallback = "refuse" | "host";

export type ProfileName = "enterprise" | "team" | "solo";

export type CredentialSource =
  | { kind: "static"; envVar?: string; keychainService?: string }
  | { kind: "host-pi-auth"; authFile?: string }
  | { kind: "sso"; command: string[] };

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

export interface VaultConfig {
  enabled: boolean;
}

interface CredentialsExtras {
  rules: CredentialRule[];
  derive: DeriveConfig;
  vault: VaultConfig;
}

type CredentialsConfig = CredentialSource & CredentialsExtras;

export interface GrantsConfig {
  enabled: boolean;
  maxHours: number;
  permanent: boolean;
}

interface ParentProxyConfig {
  url: string;
  noProxy?: string[];
  auth?: SecretRef;
}

export type ParentProxy = "env" | "none" | ParentProxyConfig;

export type ExtraCa = { file: string } | { hostStore: true };

export interface OrgRef {
  source: string;
  sha256?: string;
  refreshHours?: number;
}

interface GatewayProvider {
  id: string;
  apiKind: string;
}

export interface GatewayConfig {
  url: string;
  authHeader: string;
  placeholder: string;
  providers: GatewayProvider[];
}

export interface WorkspaceRootsConfig {
  roots: string[];
  outside: "refuse" | "warn";
}

interface EgressConfig {
  allow: string[];
  mcpHosts: string[];
  denyPrivateAddresses: true;
  deny: string[];
  privateHosts: string[];
  parentProxy: ParentProxy;
  grants: GrantsConfig;
}

interface ImageConfig {
  reference: string;
  digest?: string;
  packages?: string[];
  npmGlobal?: string[];
  dockerfile?: string;
}

export interface SandboxConfig {
  profile?: ProfileName;
  backend: Backend;
  fallback: Fallback;
  image: ImageConfig;
  gateway?: GatewayConfig;
  credentials: CredentialsConfig;
  egress: EgressConfig;
  tls: { extraCa: ExtraCa[] };
  workspaceRoots?: WorkspaceRootsConfig;
  mounts: { extraReadOnly: string[]; cacheVolumes: string[] };
  env: { allow: string[] };
  ssh: { agent: boolean };
  resources: { cpus?: number; memoryGiB?: number };
  org?: OrgRef;
}

export type LayerName = "policy" | "org" | "user" | "project";

export type ConfigSource = "default" | "profile" | LayerName;

type LayerCredentials = (CredentialSource | { kind?: undefined }) & {
  rules?: CredentialRule[];
  derive?: Partial<DeriveConfig>;
  vault?: Partial<VaultConfig>;
};

export interface LayerConfig {
  profile?: ProfileName;
  backend?: Backend;
  fallback?: Fallback;
  image?: Partial<ImageConfig>;
  gateway?: GatewayConfig;
  credentials?: LayerCredentials;
  egress?: Partial<Omit<EgressConfig, "grants">> & { grants?: Partial<GrantsConfig> };
  tls?: Partial<SandboxConfig["tls"]>;
  workspaceRoots?: WorkspaceRootsConfig;
  mounts?: Partial<SandboxConfig["mounts"]>;
  env?: Partial<SandboxConfig["env"]>;
  ssh?: Partial<SandboxConfig["ssh"]>;
  resources?: SandboxConfig["resources"];
  org?: OrgRef;
}

export interface EgressCap {
  derivedHosts?: string[];
  grants?: string[];
}

export interface EffectiveConfig {
  config: SandboxConfig;
  sources: Record<string, ConfigSource>;
  egressCap: EgressCap;
}

export interface FetchTextResult {
  status: number;
  body: string;
}

export type FetchText = (url: string, options: { timeoutMs: number }) => Promise<FetchTextResult>;

export interface OrgLayerInput {
  ref: OrgRef;
  stateDir: string;
  fetchText: FetchText;
  now: () => number;
}

export interface OrgLayerResult {
  layer: LayerConfig | undefined;
  notices: string[];
}
