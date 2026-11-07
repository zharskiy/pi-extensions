import { readFile, stat } from "node:fs/promises";
import type { CredentialRule, EgressCap } from "../config/index.ts";
import { liveSessions, readGrants } from "../grants/index.ts";
import { sha256Hex, stateLayout, type VaultServer } from "../shared/index.ts";
import {
  type DynamicSection,
  emptyDynamic,
  extraAllowList,
  parseDynamic,
  repoTokensDir,
  type StoredDynamic,
  tokenFileHashes,
} from "./dynamic.ts";
import { matchesEntry, parseEntry } from "./policy.ts";

export interface ProxyRuntime {
  repoOf(token: string): Promise<string | undefined>;
  repoOfTokenHash(tokenHash: string): Promise<string | undefined>;
  liveRepos(): Promise<Set<string>>;
  extras(repoHash: string): Promise<string[]>;
  rules(repoHash?: string): Promise<CredentialRule[]>;
  vault(repoHash?: string): Promise<VaultServer[]>;
}

export interface RuntimeOptions {
  stateDir: string;
  policyHash: string;
  staticRules: CredentialRule[];
  grantsEnabled: boolean;
  cap: EgressCap;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface Snapshot<T> {
  stamp: string;
  value: T;
}

const stampOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? "absent" : `${info.ino}:${info.mtimeMs}:${info.size}`;
};

const readJson = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

const capped = (entries: string[], cap: string[] | undefined) =>
  cap === undefined
    ? entries
    : entries.filter((entry) => {
        const parsed = parseEntry(entry);

        return cap.some((pattern) => matchesEntry(pattern, parsed.pattern, parsed.port ?? 443));
      });

const vaultHosts = (servers: VaultServer[]) => servers.flatMap((server) => server.discovery.hosts);

const uniqueServers = (servers: VaultServer[]) => [
  ...new Map(servers.map((server) => [`${server.server}|${server.url}`, server])).values(),
];

const ruleKey = (rule: CredentialRule) =>
  `${rule.id}|${rule.host.toLowerCase()}|${rule.port ?? 443}|${rule.pathPrefix ?? ""}`;

const mergeRules = (first: CredentialRule[], second: CredentialRule[]) => {
  const keys = new Set(first.map(ruleKey));

  return [...first, ...second.filter((rule) => !keys.has(ruleKey(rule)))];
};

export const createProxyRuntime = (options: RuntimeOptions): ProxyRuntime => {
  const layout = stateLayout(options.stateDir);
  const dynamicPath = layout.proxyDynamic(options.policyHash);
  const tokensDir = repoTokensDir(options.stateDir, options.policyHash);
  const now = options.now ?? Date.now;
  const cache: { dynamic: Snapshot<StoredDynamic>; tokens: Snapshot<Record<string, string>> } = {
    dynamic: { stamp: "", value: emptyDynamic() },
    tokens: { stamp: "", value: {} },
  };

  const dynamic = async () => {
    const stamp = await stampOf(dynamicPath);

    if (stamp !== cache.dynamic.stamp) {
      cache.dynamic = { stamp, value: parseDynamic(await readJson(dynamicPath)) };
    }

    return cache.dynamic.value;
  };

  const tokens = async () => {
    const stamp = await stampOf(tokensDir);

    if (stamp !== cache.tokens.stamp) {
      cache.tokens = { stamp, value: await tokenFileHashes(tokensDir) };
    }

    return cache.tokens.value;
  };

  const repoOfTokenHash = async (tokenHash: string) => {
    const fromFiles = (await tokens())[tokenHash];

    return fromFiles ?? (await dynamic()).tokens[tokenHash];
  };

  const repoOf = (token: string) => repoOfTokenHash(sha256Hex(token));

  const liveRepos = async () =>
    new Set([...Object.values(await tokens()), ...Object.values((await dynamic()).tokens)]);

  const sectionsFor = async (repoHash: string | undefined): Promise<DynamicSection[]> => {
    const current = await dynamic();
    const owned = await Promise.all(
      Object.entries(current.repos).map(async ([tokenHash, section]) => {
        const owner = await repoOfTokenHash(tokenHash);
        const wanted = owner !== undefined && (repoHash === undefined || owner === repoHash);

        return wanted ? [section] : [];
      }),
    );

    return [current.shared, ...owned.flat()];
  };

  const grantEntries = async (current: StoredDynamic, repoHash: string) => {
    if (!options.grantsEnabled) {
      return [];
    }

    const live = await liveSessions(options.stateDir, undefined, options.isAlive);
    const context = { now: now(), repoHash, liveLaunches: new Set(live.map((entry) => entry.launchId)) };
    const fromGrants = extraAllowList({
      dynamic: { ...current, derivedHosts: [] },
      grants: await readGrants(options.stateDir).catch(() => []),
      context,
    });

    return capped(fromGrants, options.cap.grants);
  };

  const vault = async (repoHash?: string) =>
    uniqueServers((await sectionsFor(repoHash)).flatMap((section) => section.vault ?? []));

  const extras = async (repoHash: string) => {
    const current = await dynamic();
    const derived = (await sectionsFor(undefined)).flatMap((section) => section.derivedHosts);

    return [
      ...capped([...new Set([...derived, ...vaultHosts(await vault(repoHash))])], options.cap.derivedHosts),
      ...(await grantEntries(current, repoHash)),
    ];
  };

  const rules = async (repoHash?: string) =>
    mergeRules(
      options.staticRules,
      (await sectionsFor(repoHash)).flatMap((section) => section.rules),
    );

  return { repoOf, repoOfTokenHash, liveRepos, extras, rules, vault };
};
