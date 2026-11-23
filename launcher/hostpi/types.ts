import type { CredentialRule, DeriveConfig } from "../config/index.ts";
import type {
  CommandRunner,
  IniSection,
  JsonObject,
  MavenRepository,
  MavenServer,
  NpmrcEntry,
  XmlElement,
} from "../shared/index.ts";

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

export interface ToolsInput {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  runner: CommandRunner;
  salt: string;
  enabled: boolean;
  excludedRoots: string[];
}

export interface GlabHost {
  host: string;
  token: string;
  user?: string;
  apiHost?: string;
  apiProtocol?: string;
}

export interface GitIdentity {
  name?: string;
  email?: string;
}

export interface DerivedTools {
  glab: GlabHost[];
  npmrc?: NpmrcEntry[];
  pip?: IniSection[];
  maven: { servers: MavenServer[]; mirrors: MavenRepository[]; passthrough: XmlElement[] };
  git: GitIdentity;
  env: Record<string, string>;
}

export const EMPTY_MAVEN: DerivedTools["maven"] = { servers: [], mirrors: [], passthrough: [] };

export const emptyTools = (git: GitIdentity = {}): DerivedTools => ({
  glab: [],
  maven: EMPTY_MAVEN,
  git,
  env: {},
});

export interface ToolRegistry {
  label: string;
  endpoint: { host: string; port?: number };
}

export interface ToolsSection {
  value: DerivedTools;
  rules: CredentialRule[];
  notices: string[];
  registries: ToolRegistry[];
}

export interface DeriveInput {
  files: HostPiFiles;
  tools?: ToolsSection;
  providerHosts: ProviderHosts;
  manual: CredentialRule[];
  egress?: string[];
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
  tools: DerivedTools;
  oauthServers: McpOAuthServer[];
  notices: string[];
}

export interface HostPi {
  command: string[];
  hostJob: string[];
  version: string;
  packageDir: string;
  location: string;
}

export interface McpOAuthServer {
  name: string;
  url: string;
}
