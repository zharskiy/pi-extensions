import type { CredentialRule } from "../config/index.ts";

export const DAEMON_FAILURE_TAG = "pi-sandbox-proxy failed:";

export interface EgressSettings {
  allow: string[];
  deny: string[];
  privateHosts: string[];
  grants: boolean;
  derivedHosts: string[];
  derivedPrivateHosts: string[];
}

export interface RepoProxyInput extends EgressSettings {
  repoHash: string;
  token: string;
  rules: CredentialRule[];
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

export const egressSettingsOf = (input: EgressSettings): EgressSettings => ({
  allow: input.allow,
  deny: input.deny,
  privateHosts: input.privateHosts,
  grants: input.grants,
  derivedHosts: input.derivedHosts,
  derivedPrivateHosts: input.derivedPrivateHosts,
});

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const parseEgressSettings = (
  value: Record<string, unknown> | undefined,
): EgressSettings | undefined =>
  value !== undefined &&
  isTextList(value.allow) &&
  isTextList(value.deny) &&
  isTextList(value.privateHosts) &&
  typeof value.grants === "boolean" &&
  isTextList(value.derivedHosts) &&
  (value.derivedPrivateHosts === undefined || isTextList(value.derivedPrivateHosts))
    ? egressSettingsOf({
        ...value,
        derivedPrivateHosts: value.derivedPrivateHosts ?? [],
      } as unknown as EgressSettings)
    : undefined;

export interface DaemonInput {
  input: RepoProxyInput;
  inputHash: string;
}
