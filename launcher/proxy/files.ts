import type { CredentialRule } from "../config/index.ts";

export interface RepoProxyInput {
  repoHash: string;
  token: string;
  allow: string[];
  deny: string[];
  privateHosts: string[];
  grants: boolean;
  rules: CredentialRule[];
  derivedHosts: string[];
  envSecrets: Record<string, string>;
  parent: "env" | "none";
  parentEnv: Record<string, string>;
  parentAuth?: string;
  extraCa: boolean;
  piCommand: string[];
  hostAgentDir: string;
  accessLogLimit: number;
}

export interface RepoProxy {
  pid: number;
  boot: number;
  start: string;
  port: number;
  inputHash: string;
}

export interface DaemonInput {
  input: RepoProxyInput;
  inputHash: string;
}
