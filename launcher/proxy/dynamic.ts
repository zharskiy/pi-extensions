import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialRule } from "../config/index.ts";
import {
  ensureRandomHexFile,
  isJsonObject,
  readJsonObject,
  sha256Hex,
  stateLayout,
  type VaultServer,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import { fetchDenials } from "./client.ts";
import type { ProxyInstance } from "./files.ts";

export interface DynamicSection {
  rules: CredentialRule[];
  derivedHosts: string[];
  vault?: VaultServer[];
}

export interface ProxyDynamic extends DynamicSection {
  version: 1;
  tokenHash?: string;
}

export interface StoredDynamic {
  version: 1;
  shared: DynamicSection;
  repos: Record<string, DynamicSection>;
}

export interface DenialRecord {
  time: number;
  host: string;
  port: number;
  repoHash: string;
  rule: string;
  reason: string;
}

const PRIVATE_MODE = 0o600;

const TOKEN_BYTES = 32;

const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

const TOKEN_HASH = /^[0-9a-f]{64}$/;

const isText = (value: unknown) => typeof value === "string" && value !== "";

const isVaultServer = (value: unknown): value is VaultServer => {
  if (!isJsonObject(value) || !isJsonObject(value.discovery)) {
    return false;
  }

  const discovery = value.discovery;

  return (
    [value.server, value.url, value.ruleId, value.access, value.refresh, value.client].every(isText) &&
    discovery.ok === true &&
    isText(discovery.tokenEndpoint) &&
    isText(discovery.authorizationEndpoint) &&
    Array.isArray(discovery.hosts) &&
    discovery.hosts.every((host) => typeof host === "string")
  );
};

const emptySection = (): DynamicSection => ({ rules: [], derivedHosts: [] });

export const emptyDynamic = (): StoredDynamic => ({ version: 1, shared: emptySection(), repos: {} });

const parseSection = (value: unknown): DynamicSection => {
  if (!isJsonObject(value)) {
    return emptySection();
  }

  return {
    rules: Array.isArray(value.rules) ? (value.rules as CredentialRule[]) : [],
    derivedHosts: Array.isArray(value.derivedHosts) ? (value.derivedHosts as string[]) : [],
    ...(Array.isArray(value.vault) ? { vault: value.vault.filter(isVaultServer) } : {}),
  };
};

const parseRepos = (value: unknown) =>
  isJsonObject(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([hash]) => TOKEN_HASH.test(hash))
          .map(([hash, section]) => [hash, parseSection(section)]),
      )
    : {};

export const parseDynamic = (value: unknown): StoredDynamic =>
  isJsonObject(value) && value.version === 1
    ? { version: 1, shared: parseSection(value.shared), repos: parseRepos(value.repos) }
    : emptyDynamic();

const sectionOf = (dynamic: ProxyDynamic): DynamicSection => ({
  rules: dynamic.rules,
  derivedHosts: dynamic.derivedHosts,
  ...(dynamic.vault === undefined ? {} : { vault: dynamic.vault }),
});

export const tokenFileHashes = async (directory: string) => {
  const names = await readdir(directory).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.map(async (repoHash) => {
      const token = await readFile(join(directory, repoHash), "utf8").catch(() => "");

      return TOKEN_PATTERN.test(token) ? ([sha256Hex(token), repoHash] as const) : undefined;
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
};

const storedWith = async (
  files: ReturnType<ReturnType<typeof stateLayout>["proxyInstance"]>,
  dynamic: ProxyDynamic,
) => {
  const current = parseDynamic(await readJsonObject(files.dynamic));
  const written = dynamic.tokenHash;
  const live = new Set(Object.keys(await tokenFileHashes(files.tokensDir)));
  const kept = Object.entries(current.repos).filter(([hash]) => live.has(hash) && hash !== written);
  const repos = Object.fromEntries(written === undefined ? kept : [...kept, [written, sectionOf(dynamic)]]);
  const stored: StoredDynamic = {
    version: 1,
    shared: written === undefined ? sectionOf(dynamic) : current.shared,
    repos,
  };

  return stored;
};

export const writeProxyDynamic = (
  stateDir: string,
  policyHash: string,
  dynamic: ProxyDynamic,
): Promise<void> => {
  const files = stateLayout(stateDir).proxyInstance(policyHash);

  return withFileLock(files.dynamicLock, async () => {
    await writeJsonFile(files.dynamic, await storedWith(files, dynamic), { mode: PRIVATE_MODE });
  });
};

export const repoProxyToken = (stateDir: string, policyHash: string, repoHash: string): Promise<string> =>
  ensureRandomHexFile(stateLayout(stateDir).proxyInstance(policyHash).repoToken(repoHash), TOKEN_BYTES);

export const removeRepoToken = (stateDir: string, policyHash: string, repoHash: string): Promise<void> =>
  rm(stateLayout(stateDir).proxyInstance(policyHash).repoToken(repoHash), { force: true });

const readToken = async (path: string) => {
  const text = await readFile(path, "utf8").catch(() => "");

  return TOKEN_PATTERN.test(text) ? text : undefined;
};

export const readDenials = async (
  stateDir: string,
  policyHash: string,
  filter: { repoHash: string; since: number },
): Promise<DenialRecord[]> => {
  const files = stateLayout(stateDir).proxyInstance(policyHash);
  const instance = (await readJsonObject(files.record)) as ProxyInstance | undefined;
  const token = await readToken(files.repoToken(filter.repoHash));

  if (instance === undefined || token === undefined) {
    return [];
  }

  return fetchDenials(instance, token, filter.since);
};
