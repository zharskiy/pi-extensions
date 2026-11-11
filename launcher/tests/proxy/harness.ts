import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:https";
import { type AddressInfo, connect, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRule } from "../../config/index.ts";
import type { AccessLogEntry } from "../../proxy/access-log.ts";
import type { Dialer } from "../../proxy/dial.ts";
import type { EgressSettings } from "../../proxy/files.ts";
import { createProxyRuntime, type ProxyRuntime } from "../../proxy/runtime.ts";
import type { SecretResolver, SecretResult } from "../../proxy/secrets/index.ts";
import { type ProxyServer, startProxyServer } from "../../proxy/server.ts";
import { type LauncherCa, openLauncherCa } from "../../proxy/tls-ca.ts";
import { createProcessRunner } from "../../shared/index.ts";

const TEST_REPO = "1".repeat(64);

const TEST_TOKEN = "c".repeat(64);

export const resolveTo =
  (addresses: Record<string, string>) =>
  async (hostname: string): Promise<LookupAddress[]> => {
    const address = addresses[hostname.toLowerCase()];

    return address === undefined ? lookup(hostname, { all: true }) : [{ address, family: isIP(address) }];
  };

export const portOf = (server: Server) => (server.address() as AddressInfo).port;

export const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

export const closeServer = (server: Server | undefined) =>
  new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();

      return;
    }

    server.closeAllConnections();

    server.close(() => resolve());
  });

export const fakeResolver = (values: Record<string, string>, failures: Record<string, SecretResult> = {}) => {
  const invalidated: string[] = [];
  const asked: string[] = [];

  const resolver: SecretResolver = {
    resolve: async (key): Promise<SecretResult> => {
      asked.push(key);

      const value = values[key];

      if (value !== undefined) {
        return { ok: true, value };
      }

      return failures[key] ?? { ok: false, reason: `no secret for ${key}` };
    },
    invalidate: (key) => {
      invalidated.push(key);
    },
    rejected: async () => undefined,
    close: async () => undefined,
  };

  return { resolver, invalidated, asked };
};

const mappedDial = (ports: () => Record<string, number>): Dialer => ({
  dial: (host, port) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: ports()[`${host}:${port}`] ?? 1 });

      socket.once("connect", () => resolve(socket));

      socket.once("error", reject);
    }),
  checkAddresses: async () => undefined,
});

export const createStateDir = () => mkdtemp(join(tmpdir(), "pi-sandbox-proxy-"));

export const removeDir = (path: string) => rm(path, { recursive: true, force: true });

export const openCa = (stateDir: string): Promise<LauncherCa> =>
  openLauncherCa({ stateDir, runner: createProcessRunner() });

export interface TestPolicy {
  allow: string[];
  deny?: string[];
  grants?: boolean;
}

export const settingsOf = (
  policy: TestPolicy,
  extra: { privateHosts?: string[]; derivedHosts?: string[]; derivedPrivateHosts?: string[] } = {},
): EgressSettings => ({
  allow: policy.allow,
  deny: policy.deny ?? [],
  privateHosts: extra.privateHosts ?? [],
  grants: policy.grants !== false,
  derivedHosts: extra.derivedHosts ?? [],
  derivedPrivateHosts: extra.derivedPrivateHosts ?? [],
});

export interface TestProxyOptions {
  stateDir: string;
  policy: TestPolicy;
  ca?: LauncherCa;
  upstreamCa?: string;
  rules?: CredentialRule[];
  derivedHosts?: string[];
  repoHash?: string;
  resolver?: SecretResolver;
  privateHosts?: string[];
  derivedPrivateHosts?: string[];
  ports?: () => Record<string, number>;
  dial?: Dialer;
}

export interface TestProxy {
  proxy: ProxyServer;
  log: AccessLogEntry[];
  runtime: ProxyRuntime;
  repoHash: string;
  token: string;
}

export const startTestProxy = async (options: TestProxyOptions): Promise<TestProxy> => {
  const log: AccessLogEntry[] = [];
  const ca = options.ca ?? (await openCa(options.stateDir));
  const repoHash = options.repoHash ?? TEST_REPO;
  const runtime = createProxyRuntime({
    stateDir: options.stateDir,
    repoHash,
    rules: options.rules ?? [],
    settings: settingsOf(options.policy, options),
  });
  const proxy = await startProxyServer({
    listen: { host: "127.0.0.1", port: 0 },
    repoHash,
    token: TEST_TOKEN,
    runtime,
    resolver: options.resolver ?? fakeResolver({}).resolver,
    ca,
    log: (entry) => log.push(entry),
    dial: options.dial ?? mappedDial(options.ports ?? (() => ({}))),
    upstreamCa: options.upstreamCa ?? ca.certPem,
    helloTimeoutMs: 500,
  });

  return { proxy, log, runtime, repoHash, token: TEST_TOKEN };
};

export const waitFor = async <T>(find: () => T | undefined, attempts = 100): Promise<T> => {
  const found = find();

  if (found !== undefined) {
    return found;
  }

  if (attempts === 0) {
    throw new Error("condition not met");
  }

  await new Promise((resolve) => setTimeout(resolve, 20));

  return waitFor(find, attempts - 1);
};
