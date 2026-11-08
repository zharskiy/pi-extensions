import type { CredentialRule, DeriveConfig } from "../config/index.ts";
import type { JsonObject } from "../shared/index.ts";

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
  manual: CredentialRule[];
  salt: string;
  env: Record<string, string | undefined>;
  derive: DeriveConfig;
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
  name: string;
  url: string;
}
