import { readFile } from "node:fs/promises";
import type { CredentialRule } from "../config/index.ts";
import { stateLayout } from "../shared/index.ts";

export const DAEMON_FAILURE_TAG = "pi-sandbox-proxy failed:";

export const LISTEN_HOST = "127.0.0.1";

const EGRESS_KEYS = ["allow", "deny", "privateHosts", "derivedHosts"] as const;

export type EgressSettings = Record<(typeof EGRESS_KEYS)[number], string[]>;

export interface RepoProxyInput extends EgressSettings {
  repoHash: string;
  token: string;
  rules: CredentialRule[];
  envSecrets: Record<string, string>;
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

const isEgressKey = (key: string) => EGRESS_KEYS.some((egressKey) => egressKey === key);

export const egressSettingsOf = (input: EgressSettings): EgressSettings =>
  Object.fromEntries(EGRESS_KEYS.map((key) => [key, input[key]])) as EgressSettings;

export const withoutEgressSettings = (input: object) =>
  Object.fromEntries(Object.entries(input).filter(([key]) => !isEgressKey(key)));

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const parseEgressSettings = (
  value: Record<string, unknown> | undefined,
): EgressSettings | undefined =>
  value !== undefined && EGRESS_KEYS.every((key) => isTextList(value[key]))
    ? egressSettingsOf(value as unknown as EgressSettings)
    : undefined;

export const readExtraCaPem = async (stateDir: string, extraCa: boolean) =>
  extraCa ? readFile(stateLayout(stateDir).extraPem, "utf8").catch(() => "") : "";

export interface DaemonInput {
  input: RepoProxyInput;
  inputHash: string;
}
