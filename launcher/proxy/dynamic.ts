import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { dirname, join } from "node:path";
import type { CredentialRule } from "../config/index.ts";
import { type ActiveGrantContext, activeGrants, type Grant } from "../grants/index.ts";
import {
  readJsonFile,
  sha256Hex,
  stateLayout,
  type VaultServer,
  writeFileAtomic,
  writeJsonFile,
} from "../shared/index.ts";
import { proxyAuthorization } from "./auth.ts";
import { type ProxyInstance, proxyFiles } from "./files.ts";
import { authorityOf } from "./policy.ts";

export interface DynamicSection {
  rules: CredentialRule[];
  derivedHosts: string[];
  vault?: VaultServer[];
}

export interface ProxyDynamic extends DynamicSection {
  version: 1;
  tokens: Record<string, string>;
}

export interface StoredDynamic extends ProxyDynamic {
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

export interface AllowListInput {
  dynamic: ProxyDynamic;
  grants: Grant[];
  context: ActiveGrantContext;
}

const PRIVATE_MODE = 0o600;

const TOKEN_BYTES = 32;

const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

const TOKEN_HASH = /^[0-9a-f]{64}$/;

const LISTEN_HOST = "127.0.0.1";

const REQUEST_TIMEOUT_MS = 1000;

const isText = (value: unknown) => typeof value === "string" && value !== "";

const isVaultServer = (value: unknown): value is VaultServer => {
  const server = value as Partial<VaultServer> | undefined;
  const discovery = server?.discovery as Partial<VaultServer["discovery"]> | undefined;

  return (
    typeof server === "object" &&
    server !== null &&
    [server.server, server.url, server.ruleId, server.access, server.refresh, server.client].every(isText) &&
    discovery?.ok === true &&
    isText(discovery.tokenEndpoint) &&
    isText(discovery.authorizationEndpoint) &&
    Array.isArray(discovery.hosts) &&
    discovery.hosts.every((host) => typeof host === "string")
  );
};

const emptySection = (): DynamicSection => ({ rules: [], derivedHosts: [] });

export const emptyDynamic = (): StoredDynamic => ({
  version: 1,
  rules: [],
  derivedHosts: [],
  tokens: {},
  shared: emptySection(),
  repos: {},
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSection = (value: unknown): DynamicSection => {
  const section = value as Partial<DynamicSection> | undefined;

  if (!isObject(section)) {
    return emptySection();
  }

  return {
    rules: Array.isArray(section.rules) ? section.rules : [],
    derivedHosts: Array.isArray(section.derivedHosts) ? section.derivedHosts : [],
    ...(Array.isArray(section.vault) ? { vault: section.vault.filter(isVaultServer) } : {}),
  };
};

const parseRepos = (value: unknown) =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([hash]) => TOKEN_HASH.test(hash))
          .map(([hash, section]) => [hash, parseSection(section)]),
      )
    : {};

export const parseDynamic = (value: unknown): StoredDynamic => {
  const dynamic = value as Partial<StoredDynamic> | undefined;

  if (typeof dynamic !== "object" || dynamic === null || dynamic.version !== 1) {
    return emptyDynamic();
  }

  const legacy = dynamic.shared === undefined && dynamic.repos === undefined;

  return {
    version: 1,
    ...parseSection(dynamic),
    tokens: isObject(dynamic.tokens) ? (dynamic.tokens as Record<string, string>) : {},
    shared: parseSection(legacy ? dynamic : dynamic.shared),
    repos: parseRepos(dynamic.repos),
  };
};

const unique = <T>(items: T[], key: (item: T) => string) => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

const unionOf = (sections: DynamicSection[]): DynamicSection => {
  const vault = sections.flatMap((section) => section.vault ?? []);

  return {
    rules: unique(
      sections.flatMap((section) => section.rules),
      (rule) => JSON.stringify(rule),
    ),
    derivedHosts: unique(
      sections.flatMap((section) => section.derivedHosts),
      (host) => host,
    ),
    vault: unique(vault, (server) => `${server.server}|${server.url}`),
  };
};

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

export const repoTokensDir = (stateDir: string, policyHash: string) =>
  dirname(stateLayout(stateDir).proxyRepoToken(policyHash, "repo"));

export const writeProxyDynamic = async (
  stateDir: string,
  policyHash: string,
  dynamic: ProxyDynamic,
): Promise<void> => {
  const path = stateLayout(stateDir).proxyDynamic(policyHash);
  const current = parseDynamic(await readJsonFile<unknown>(path).catch(() => undefined));
  const written = Object.keys(dynamic.tokens);
  const live = new Set([
    ...Object.keys(await tokenFileHashes(repoTokensDir(stateDir, policyHash))),
    ...written,
  ]);
  const kept = Object.entries(current.repos).filter(([hash]) => live.has(hash) && !written.includes(hash));
  const repos = Object.fromEntries([...kept, ...written.map((hash) => [hash, sectionOf(dynamic)] as const)]);
  const shared = written.length === 0 ? sectionOf(dynamic) : current.shared;
  const stored: StoredDynamic = {
    version: 1,
    ...unionOf([shared, ...Object.values(repos)]),
    tokens: { ...current.tokens, ...dynamic.tokens },
    shared,
    repos,
  };

  await writeJsonFile(path, stored, { mode: PRIVATE_MODE });
};

const readToken = async (path: string) => {
  const text = await readFile(path, "utf8").catch(() => "");

  return TOKEN_PATTERN.test(text) ? text : undefined;
};

export const repoProxyToken = async (
  stateDir: string,
  policyHash: string,
  repoHash: string,
): Promise<string> => {
  const path = stateLayout(stateDir).proxyRepoToken(policyHash, repoHash);
  const stored = await readToken(path);

  if (stored !== undefined) {
    return stored;
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const created = await writeFile(path, token, { mode: PRIVATE_MODE, flag: "wx" }).then(
    () => true,
    () => false,
  );

  if (created) {
    return token;
  }

  const raced = await readToken(path);

  if (raced !== undefined) {
    return raced;
  }

  await writeFileAtomic(path, token, { mode: PRIVATE_MODE });

  return token;
};

const fetchDenials = (instance: ProxyInstance, token: string, since: number) =>
  new Promise<DenialRecord[]>((resolve) => {
    const request = get(
      {
        host: LISTEN_HOST,
        port: instance.port,
        path: `/denials?since=${since}`,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "proxy-authorization": proxyAuthorization(token) },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));

        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { denials?: DenialRecord[] };

            resolve(response.statusCode === 200 && Array.isArray(body.denials) ? body.denials : []);
          } catch {
            resolve([]);
          }
        });
      },
    );

    request.on("timeout", () => request.destroy());

    request.on("error", () => resolve([]));
  });

export const readDenials = async (
  stateDir: string,
  policyHash: string,
  filter: { repoHash: string; since: number },
): Promise<DenialRecord[]> => {
  const instance = await readJsonFile<ProxyInstance>(proxyFiles(stateDir, policyHash).record).catch(
    () => undefined,
  );
  const token = await readToken(stateLayout(stateDir).proxyRepoToken(policyHash, filter.repoHash));

  if (instance === undefined || token === undefined) {
    return [];
  }

  return fetchDenials(instance, token, filter.since);
};

export const extraAllowList = (input: AllowListInput): string[] => [
  ...activeGrants(input.grants, input.context).map((grant) => authorityOf(grant.host, grant.port)),
  ...input.dynamic.derivedHosts,
];
