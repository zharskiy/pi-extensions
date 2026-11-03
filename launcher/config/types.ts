import type { BackendName } from "../shared/index.ts";

type Backend = "auto" | BackendName;

type Fallback = "refuse" | "host";

export type ProfileName = "enterprise" | "team" | "solo";

export type CredentialSource =
  | { kind: "static"; envVar?: string; keychainService?: string }
  | { kind: "host-pi-auth"; authFile?: string }
  | { kind: "sso"; command: string[] };

export interface GatewayProvider {
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

export interface SandboxConfig {
  profile?: ProfileName;
  backend: Backend;
  fallback: Fallback;
  image: { reference: string; digest?: string };
  gateway?: GatewayConfig;
  credentials: CredentialSource;
  egress: { allow: string[]; mcpHosts: string[]; denyPrivateAddresses: true };
  workspaceRoots?: WorkspaceRootsConfig;
  mounts: { extraReadOnly: string[]; cacheVolumes: string[] };
  env: { allow: string[] };
  ssh: { agent: boolean };
  resources: { cpus?: number; memoryGiB?: number };
}

export type LayerName = "policy" | "user" | "project";

export type ConfigSource = "default" | "profile" | LayerName;

export interface LayerConfig {
  profile?: ProfileName;
  backend?: Backend;
  fallback?: Fallback;
  image?: Partial<SandboxConfig["image"]>;
  gateway?: GatewayConfig;
  credentials?: CredentialSource;
  egress?: Partial<SandboxConfig["egress"]>;
  workspaceRoots?: WorkspaceRootsConfig;
  mounts?: Partial<SandboxConfig["mounts"]>;
  env?: Partial<SandboxConfig["env"]>;
  ssh?: Partial<SandboxConfig["ssh"]>;
  resources?: SandboxConfig["resources"];
}

export interface EffectiveConfig {
  config: SandboxConfig;
  sources: Record<string, ConfigSource>;
}
