import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialRule, EgressCap } from "../config/index.ts";
import { liveSessions, readGrants } from "../grants/index.ts";
import { sha256Hex, stateLayout, type VaultServer } from "../shared/index.ts";
import { emptyDynamic, extraAllowList, type ProxyDynamic, parseDynamic, TOKEN_PATTERN } from "./dynamic.ts";
import { matchesEntry, parseEntry } from "./policy.ts";

export interface ProxyRuntime {
  repoOf(token: string): Promise<string | undefined>;
  extras(repoHash: string): Promise<string[]>;
  rules(): Promise<CredentialRule[]>;
  vault(): Promise<VaultServer[]>;
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

const tokenFiles = async (directory: string) => {
  const names = await readdir(directory).catch(() => []);
  const entries = await Promise.all(
    names.map(async (repoHash) => {
      const token = await readFile(join(directory, repoHash), "utf8").catch(() => "");

      return TOKEN_PATTERN.test(token) ? ([sha256Hex(token), repoHash] as const) : undefined;
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
};

const capped = (entries: string[], cap: string[] | undefined) =>
  cap === undefined
    ? entries
    : entries.filter((entry) => {
        const parsed = parseEntry(entry);

        return cap.some((pattern) => matchesEntry(pattern, parsed.pattern, parsed.port ?? 443));
      });

const vaultHosts = (current: ProxyDynamic) =>
  (current.vault ?? []).flatMap((server) => server.discovery.hosts);

const ruleKey = (rule: CredentialRule) =>
  `${rule.id}|${rule.host.toLowerCase()}|${rule.port ?? 443}|${rule.pathPrefix ?? ""}`;

const mergeRules = (first: CredentialRule[], second: CredentialRule[]) => {
  const keys = new Set(first.map(ruleKey));

  return [...first, ...second.filter((rule) => !keys.has(ruleKey(rule)))];
};

export const createProxyRuntime = (options: RuntimeOptions): ProxyRuntime => {
  const layout = stateLayout(options.stateDir);
  const dynamicPath = layout.proxyDynamic(options.policyHash);
  const tokensDir = dirname(layout.proxyRepoToken(options.policyHash, "repo"));
  const now = options.now ?? Date.now;
  const cache: { dynamic: Snapshot<ProxyDynamic>; tokens: Snapshot<Record<string, string>> } = {
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
      cache.tokens = { stamp, value: await tokenFiles(tokensDir) };
    }

    return cache.tokens.value;
  };

  const repoOf = async (token: string) => {
    const hash = sha256Hex(token);
    const fromFiles = (await tokens())[hash];

    return fromFiles ?? (await dynamic()).tokens[hash];
  };

  const grantEntries = async (current: ProxyDynamic, repoHash: string) => {
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

  const extras = async (repoHash: string) => {
    const current = await dynamic();

    return [
      ...capped([...current.derivedHosts, ...vaultHosts(current)], options.cap.derivedHosts),
      ...(await grantEntries(current, repoHash)),
    ];
  };

  const rules = async () => mergeRules(options.staticRules, (await dynamic()).rules);

  const vault = async () => (await dynamic()).vault ?? [];

  return { repoOf, extras, rules, vault };
};
