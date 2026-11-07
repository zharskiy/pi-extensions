import type { CredentialRule, CredentialSource, DeriveConfig, GatewayConfig } from "../config/index.ts";

export type JsonObject = Record<string, unknown>;

export interface HostPiFiles {
  agentDir: string;
  auth?: JsonObject;
  models?: JsonObject;
  mcp?: JsonObject;
  settings?: JsonObject;
  notices?: string[];
}

export interface ProviderHostEntry {
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
}

export interface DerivedFiles {
  "auth.json": JsonObject;
  "models.json": JsonObject;
  "mcp.json": JsonObject;
}

export interface DerivedSandboxPi {
  rules: CredentialRule[];
  hosts: string[];
  files: DerivedFiles;
  notices: string[];
}

export type PackageChangeKind = "install" | "remove";

export interface PackageChange {
  hostAgentDir: string;
  source: string;
  kind: PackageChangeKind;
  entry?: unknown;
}

export interface BundledPi {
  command: string[];
  version: string;
  packageDir: string;
}

export interface McpOAuthServer {
  url: string;
  oauth?: Record<string, string | number | boolean>;
}
