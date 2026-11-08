import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialRule } from "../config/index.ts";
import {
  ensureRandomHexFile,
  isJsonObject,
  readJsonObject,
  sha256Hex,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import { fetchDenials } from "./client.ts";
import type { ProxyInstance } from "./files.ts";

export interface DynamicSection {
  rules: CredentialRule[];
  derivedHosts: string[];
}

export interface ProxyDynamic extends DynamicSection {
  tokenHash: string;
}

export interface StoredDynamic {
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

const emptySection = (): DynamicSection => ({ rules: [], derivedHosts: [] });

export const emptyDynamic = (): StoredDynamic => ({ repos: {} });

const parseSection = (value: unknown): DynamicSection => {
  if (!isJsonObject(value)) {
    return emptySection();
  }

  return {
    rules: Array.isArray(value.rules) ? (value.rules as CredentialRule[]) : [],
    derivedHosts: Array.isArray(value.derivedHosts) ? (value.derivedHosts as string[]) : [],
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
  isJsonObject(value) ? { repos: parseRepos(value.repos) } : emptyDynamic();

const sectionOf = (dynamic: ProxyDynamic): DynamicSection => ({
  rules: dynamic.rules,
  derivedHosts: dynamic.derivedHosts,
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
  const stored: StoredDynamic = { repos: Object.fromEntries([...kept, [written, sectionOf(dynamic)]]) };

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
