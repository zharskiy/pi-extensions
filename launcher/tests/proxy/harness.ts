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
import { repoProxyToken } from "../../proxy/dynamic.ts";
import type { EgressPolicy } from "../../proxy/policy.ts";
import { createProxyRuntime, type ProxyRuntime } from "../../proxy/runtime.ts";
import type { SecretResolver, SecretResult } from "../../proxy/secrets/index.ts";
import { type ProxyServer, startProxyServer } from "../../proxy/server.ts";
import { type LauncherCa, openLauncherCa } from "../../proxy/tls-ca.ts";
import { createProcessRunner } from "../../shared/index.ts";

export const POLICY_HASH = "a".repeat(64);

export const CONTROL_TOKEN = "c".repeat(64);

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

export const fakeResolver = (values: Record<string, string>) => {
  const invalidated: string[] = [];
  const asked: string[] = [];

  const resolver: SecretResolver = {
    resolve: async (key): Promise<SecretResult> => {
      asked.push(key);

      const value = values[key];

      return value === undefined ? { ok: false, reason: `no secret for ${key}` } : { ok: true, value };
    },
    invalidate: (key) => {
      invalidated.push(key);
    },
    rejected: async () => undefined,
    close: async () => undefined,
  };

  return { resolver, invalidated, asked };
};

const mappedDial =
  (ports: () => Record<string, number>) =>
  (host: string, port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: ports()[`${host}:${port}`] ?? 1 });

      socket.once("connect", () => resolve(socket));

      socket.once("error", reject);
    });

export const createStateDir = () => mkdtemp(join(tmpdir(), "pi-sandbox-proxy-"));

export const removeDir = (path: string) => rm(path, { recursive: true, force: true });

export const openCa = (stateDir: string): Promise<LauncherCa> =>
  openLauncherCa({ stateDir, runner: createProcessRunner() });

export interface TestProxyOptions {
  stateDir: string;
  policy: EgressPolicy;
  ca?: LauncherCa;
  rules?: CredentialRule[];
  grantsEnabled?: boolean;
  resolver?: SecretResolver;
  privateHosts?: string[];
  ports?: () => Record<string, number>;
  dial?: Dialer;
  onControl?: Parameters<typeof startProxyServer>[0]["onControl"];
  denialPages?: Parameters<typeof startProxyServer>[0]["denialPages"];
}

export interface TestProxy {
  proxy: ProxyServer;
  log: AccessLogEntry[];
  runtime: ProxyRuntime;
  tokenOf(repoHash: string): Promise<string>;
}

export const startTestProxy = async (options: TestProxyOptions): Promise<TestProxy> => {
  const log: AccessLogEntry[] = [];
  const runtime = createProxyRuntime({
    stateDir: options.stateDir,
    policyHash: POLICY_HASH,
    staticRules: options.rules ?? [],
    grantsEnabled: options.grantsEnabled ?? true,
  });
  const proxy = await startProxyServer({
    listen: { host: "127.0.0.1", port: 0 },
    policy: options.policy,
    policyHash: POLICY_HASH,
    controlToken: CONTROL_TOKEN,
    runtime,
    resolver: options.resolver ?? fakeResolver({}).resolver,
    privateHosts: options.privateHosts,
    ca: options.ca,
    log: (entry) => log.push(entry),
    dial: options.dial ?? mappedDial(options.ports ?? (() => ({}))),
    upstreamCa: options.ca?.certPem,
    helloTimeoutMs: 500,
    onControl: options.onControl,
    denialPages: options.denialPages,
  });

  return {
    proxy,
    log,
    runtime,
    tokenOf: (repoHash) => repoProxyToken(options.stateDir, POLICY_HASH, repoHash),
  };
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
