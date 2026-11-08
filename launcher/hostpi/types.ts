import type { CredentialRule, CredentialSource, DeriveConfig, GatewayConfig } from "../config/index.ts";
import type { CommandRunner, JsonObject, VaultDiscovery, VaultServer } from "../shared/index.ts";

export type { JsonObject } from "../shared/index.ts";

export interface HostPiFiles {
  agentDir: string;
  auth?: JsonObject;
  models?: JsonObject;
  mcp?: JsonObject;
  settings?: JsonObject;
  notices?: string[];
}

interface ProviderHostEntry {
  hosts: string[];
  envVars?: string[];
}

export type ProviderHosts = Record<string, ProviderHostEntry>;

export interface DeriveInput {
  files: HostPiFiles;
  providerHosts: ProviderHosts;
  gateway?: GatewayConfig;
  credentials?: CredentialSource;
  manual: CredentialRule[];
  salt: string;
  env: Record<string, string | undefined>;
  derive: DeriveConfig;
  mcpSignedIn: string[];
  vault?: DeriveVault;
}

export interface DeriveVault {
  enabled: boolean;
  discovery: Record<string, VaultDiscovery>;
}

interface DerivedFiles {
  "auth.json": JsonObject;
  "models.json": JsonObject;
  "mcp.json": JsonObject;
}

export interface DerivedSandboxPi {
  rules: CredentialRule[];
  hosts: string[];
  files: DerivedFiles;
  notices: string[];
  vault: VaultServer[];
}

export type PackageChangeKind = "install" | "remove";

export interface PackageChange {
  hostAgentDir: string;
  source: string;
  kind: PackageChangeKind;
}

export interface BundledPi {
  command: string[];
  version: string;
  packageDir: string;
}

type HostPiSource = "managed" | "path" | "bundled";

export interface HostPi extends BundledPi {
  source: HostPiSource;
  wrapper?: string;
}

export interface McpOAuthServer {
  url: string;
  oauth?: Record<string, string | number | boolean>;
}

export interface VaultDiscoveryInput {
  stateDir: string;
  runner: CommandRunner;
  pi: BundledPi;
  candidates: Record<string, McpOAuthServer>;
  now: () => number;
}

export interface VaultDiscoveryResult {
  discovery: Record<string, VaultDiscovery>;
  notices: string[];
}

export interface ContainerMcpAuthInput {
  stateDir: string;
  servers: VaultServer[];
}

export type ContainerMcpAuthEntries = Record<string, JsonObject | null>;
