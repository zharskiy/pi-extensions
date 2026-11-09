import { stat } from "node:fs/promises";
import { authorityOf, type CredentialRule } from "../config/index.ts";
import { activeGrants, type Grant, readGrants } from "../grants/index.ts";
import { stateLayout } from "../shared/index.ts";

export interface ProxyRuntime {
  extras(): Promise<string[]>;
  rules(): CredentialRule[];
}

export interface RuntimeOptions {
  stateDir: string;
  repoHash: string;
  rules: CredentialRule[];
  derivedHosts: string[];
  grantsEnabled: boolean;
}

const stampOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? "absent" : `${info.ino}:${info.mtimeMs}:${info.size}`;
};

const liveGrants = (stateDir: string) => {
  const path = stateLayout(stateDir).grants;
  const cache: { stamp: string; grants: Grant[] } = { stamp: "", grants: [] };

  return async () => {
    const stamp = await stampOf(path);

    if (stamp !== cache.stamp) {
      cache.stamp = stamp;
      cache.grants = await readGrants(stateDir).catch(() => []);
    }

    return cache.grants;
  };
};

export const createProxyRuntime = (options: RuntimeOptions): ProxyRuntime => {
  const grants = liveGrants(options.stateDir);

  const grantEntries = async () =>
    options.grantsEnabled
      ? activeGrants(await grants(), options.repoHash).map((grant) => authorityOf(grant.host, grant.port))
      : [];

  const extras = async () => [...new Set(options.derivedHosts), ...(await grantEntries())];

  return { extras, rules: () => options.rules };
};
