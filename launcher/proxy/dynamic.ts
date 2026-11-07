import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { dirname } from "node:path";
import type { CredentialRule } from "../config/index.ts";
import { type ActiveGrantContext, activeGrants, type Grant } from "../grants/index.ts";
import {
  readJsonFile,
  stateLayout,
  type VaultServer,
  writeFileAtomic,
  writeJsonFile,
} from "../shared/index.ts";
import { proxyAuthorization } from "./auth.ts";
import { type ProxyInstance, proxyFiles } from "./files.ts";
import { authorityOf } from "./policy.ts";

export interface ProxyDynamic {
  version: 1;
  rules: CredentialRule[];
  derivedHosts: string[];
  tokens: Record<string, string>;
  vault?: VaultServer[];
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

export const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

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

export const emptyDynamic = (): ProxyDynamic => ({ version: 1, rules: [], derivedHosts: [], tokens: {} });

export const parseDynamic = (value: unknown): ProxyDynamic => {
  const dynamic = value as Partial<ProxyDynamic> | undefined;

  if (typeof dynamic !== "object" || dynamic === null || dynamic.version !== 1) {
    return emptyDynamic();
  }

  return {
    version: 1,
    rules: Array.isArray(dynamic.rules) ? dynamic.rules : [],
    derivedHosts: Array.isArray(dynamic.derivedHosts) ? dynamic.derivedHosts : [],
    tokens: typeof dynamic.tokens === "object" && dynamic.tokens !== null ? dynamic.tokens : {},
    ...(Array.isArray(dynamic.vault) ? { vault: dynamic.vault.filter(isVaultServer) } : {}),
  };
};

export const writeProxyDynamic = async (
  stateDir: string,
  policyHash: string,
  dynamic: ProxyDynamic,
): Promise<void> => {
  const path = stateLayout(stateDir).proxyDynamic(policyHash);
  const current = parseDynamic(await readJsonFile<unknown>(path).catch(() => undefined));

  await writeJsonFile(
    path,
    { ...dynamic, tokens: { ...current.tokens, ...dynamic.tokens } },
    { mode: PRIVATE_MODE },
  );
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
