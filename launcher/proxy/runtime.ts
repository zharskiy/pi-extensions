import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  authorityOf,
  type CredentialRule,
  type EgressCap,
  matchesEntry,
  parseEntry,
  TLS_PORT,
} from "../config/index.ts";
import { activeGrants, type Grant, liveSessions, readGrants } from "../grants/index.ts";
import { readJsonObject, sha256Hex, stateLayout, type VaultServer } from "../shared/index.ts";
import {
  type DynamicSection,
  emptyDynamic,
  parseDynamic,
  type StoredDynamic,
  tokenFileHashes,
} from "./dynamic.ts";

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

interface OwnedSection {
  owner?: string;
  section: DynamicSection;
}

const stampOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? "absent" : `${info.ino}:${info.mtimeMs}:${info.size}`;
};

const directoryStampOf = async (directory: string) => {
  const names = await readdir(directory).catch(() => undefined);

  if (names === undefined) {
    return "absent";
  }

  const stamps = await Promise.all(
    names.sort().map(async (name) => `${name}=${await stampOf(join(directory, name))}`),
  );

  return stamps.join("|");
};

const stampCached = <T>(stampNow: () => Promise<string>, load: () => Promise<T>, initial: T) => {
  const cache: { snapshot: Snapshot<T> } = { snapshot: { stamp: "", value: initial } };

  return async () => {
    const stamp = await stampNow();

    if (stamp !== cache.snapshot.stamp) {
      cache.snapshot = { stamp, value: await load() };
    }

    return cache.snapshot.value;
  };
};

const capped = (entries: string[], cap: string[] | undefined) =>
  cap === undefined
    ? entries
    : entries.filter((entry) => {
        const parsed = parseEntry(entry);

        return cap.some((pattern) => matchesEntry(pattern, parsed.pattern, parsed.port ?? TLS_PORT));
      });

const vaultHosts = (servers: VaultServer[]) => servers.flatMap((server) => server.discovery.hosts);

const uniqueServers = (servers: VaultServer[]) => [
  ...new Map(servers.map((server) => [`${server.server}|${server.url}`, server])).values(),
];

const ruleKey = (rule: CredentialRule) =>
  `${rule.id}|${rule.host.toLowerCase()}|${rule.port ?? TLS_PORT}|${rule.pathPrefix ?? ""}`;

const mergeRules = (first: CredentialRule[], second: CredentialRule[]) => {
  const keys = new Set(first.map(ruleKey));

  return [...first, ...second.filter((rule) => !keys.has(ruleKey(rule)))];
};

const visibleTo = (sections: OwnedSection[], repoHash: string | undefined) =>
  sections
    .filter((entry) => repoHash === undefined || entry.owner === undefined || entry.owner === repoHash)
    .map((entry) => entry.section);

const serversOf = (sections: DynamicSection[]) =>
  uniqueServers(sections.flatMap((section) => section.vault ?? []));

export const createProxyRuntime = (options: RuntimeOptions): ProxyRuntime => {
  const layout = stateLayout(options.stateDir);
  const files = layout.proxyInstance(options.policyHash);
  const now = options.now ?? Date.now;

  const dynamic = stampCached<StoredDynamic>(
    () => stampOf(files.dynamic),
    async () => parseDynamic(await readJsonObject(files.dynamic)),
    emptyDynamic(),
  );

  const tokens = stampCached<Record<string, string>>(
    () => directoryStampOf(files.tokensDir),
    () => tokenFileHashes(files.tokensDir),
    {},
  );

  const grants = stampCached<Grant[]>(
    () => stampOf(layout.grants),
    () => readGrants(options.stateDir).catch(() => []),
    [],
  );

  const repoOfTokenHash = async (tokenHash: string) => (await tokens())[tokenHash];

  const repoOf = (token: string) => repoOfTokenHash(sha256Hex(token));

  const liveRepos = async () => new Set(Object.values(await tokens()));

  const ownedSections = async (): Promise<OwnedSection[]> => {
    const [current, owners] = await Promise.all([dynamic(), tokens()]);
    const owned = Object.entries(current.repos).flatMap(([tokenHash, section]) => {
      const owner = owners[tokenHash];

      return owner === undefined ? [] : [{ owner, section }];
    });

    return [{ section: current.shared }, ...owned];
  };

  const grantEntries = async (repoHash: string) => {
    if (!options.grantsEnabled) {
      return [];
    }

    const live = await liveSessions(options.stateDir, undefined, options.isAlive);
    const context = { now: now(), repoHash, liveLaunches: new Set(live.map((entry) => entry.launchId)) };
    const granted = activeGrants(await grants(), context).map((grant) => authorityOf(grant.host, grant.port));

    return capped(granted, options.cap.grants);
  };

  const vault = async (repoHash?: string) => serversOf(visibleTo(await ownedSections(), repoHash));

  const extras = async (repoHash: string) => {
    const sections = await ownedSections();
    const derived = sections.flatMap((entry) => entry.section.derivedHosts);
    const hosts = vaultHosts(serversOf(visibleTo(sections, repoHash)));

    return [
      ...capped([...new Set([...derived, ...hosts])], options.cap.derivedHosts),
      ...(await grantEntries(repoHash)),
    ];
  };

  const rules = async (repoHash?: string) =>
    mergeRules(
      options.staticRules,
      visibleTo(await ownedSections(), repoHash).flatMap((section) => section.rules),
    );

  return { repoOf, repoOfTokenHash, liveRepos, extras, rules, vault };
};
