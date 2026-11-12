import { stat } from "node:fs/promises";
import { authorityOf, type CredentialRule } from "../config/index.ts";
import { activeGrants, type Grant, readGrants } from "../grants/index.ts";
import { readJsonObject, stateLayout } from "../shared/index.ts";
import { type EgressSettings, parseEgressSettings } from "./files.ts";

interface LiveEgress {
  settings: EgressSettings;
  extras: string[];
}

export interface ProxyRuntime {
  egress(): Promise<LiveEgress>;
  rules(): CredentialRule[];
}

export interface RuntimeOptions {
  stateDir: string;
  repoHash: string;
  rules: CredentialRule[];
  settings: EgressSettings;
}

const stampOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? "absent" : `${info.ino}:${info.mtimeMs}:${info.size}`;
};

interface LiveCache<T> {
  stamp: string;
  value: T;
  pending?: { stamp: string; result: Promise<T> };
}

const liveFile = <T>(
  path: string,
  initial: T,
  read: () => Promise<T | undefined>,
  failed: (last: T) => T,
) => {
  const cache: LiveCache<T> = { stamp: "", value: initial };

  const reload = async (stamp: string) => {
    const value = await read().catch(() => undefined);

    if (value === undefined) {
      return failed(cache.value);
    }

    cache.stamp = stamp;
    cache.value = value;

    return value;
  };

  return async () => {
    const stamp = await stampOf(path);

    if (stamp === cache.stamp) {
      return cache.value;
    }

    if (cache.pending?.stamp !== stamp) {
      const result = reload(stamp).finally(() => {
        if (cache.pending?.result === result) {
          cache.pending = undefined;
        }
      });

      cache.pending = { stamp, result };
    }

    return cache.pending.result;
  };
};

export const createProxyRuntime = (options: RuntimeOptions): ProxyRuntime => {
  const layout = stateLayout(options.stateDir);
  const egressPath = layout.repo(options.repoHash).proxy.egress;
  const grants = liveFile<Grant[]>(
    layout.grants,
    [],
    () => readGrants(options.stateDir),
    () => [],
  );
  const settings = liveFile(
    egressPath,
    options.settings,
    async () => parseEgressSettings(await readJsonObject(egressPath)),
    (last) => last,
  );

  const grantEntries = async () =>
    activeGrants(await grants(), options.repoHash).map((grant) => authorityOf(grant.host, grant.port));

  const egress = async (): Promise<LiveEgress> => {
    const current = await settings();

    return {
      settings: current,
      extras: [...new Set(current.derivedHosts), ...(await grantEntries())],
    };
  };

  return { egress, rules: () => options.rules };
};
