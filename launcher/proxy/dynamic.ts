import type { CredentialRule } from "../config/index.ts";
import type { ActiveGrantContext, Grant } from "../grants/index.ts";
import { LauncherError } from "../shared/index.ts";

export interface ProxyDynamic {
  version: 1;
  rules: CredentialRule[];
  derivedHosts: string[];
  tokens: Record<string, string>;
}

export interface DenialRecord {
  time: number;
  host: string;
  port: number;
  repoHash: string;
  rule: string;
  reason: string;
}

export interface AllowListInput {
  dynamic: ProxyDynamic;
  grants: Grant[];
  context: ActiveGrantContext;
}

export const writeProxyDynamic = async (
  _stateDir: string,
  _policyHash: string,
  _dynamic: ProxyDynamic,
): Promise<void> => {
  throw new LauncherError("writeProxyDynamic is not implemented");
};

export const repoProxyToken = async (
  _stateDir: string,
  _policyHash: string,
  _repoHash: string,
): Promise<string> => {
  throw new LauncherError("repoProxyToken is not implemented");
};

export const readDenials = async (
  _stateDir: string,
  _policyHash: string,
  _filter: { repoHash: string; since: number },
): Promise<DenialRecord[]> => {
  throw new LauncherError("readDenials is not implemented");
};

export const extraAllowList = (_input: AllowListInput): string[] => {
  throw new LauncherError("extraAllowList is not implemented");
};
