import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CommandRunner,
  createProcessRunner,
  ensureRandomHexFile,
  ensureSalt,
  isLiveFile,
  LauncherError,
  launcherEntry,
  readJsonObject,
  stableHash,
  stateLayout,
  terminateProcess,
} from "../shared/index.ts";
import { capLog } from "./access-log.ts";
import { minimalEnv } from "./child-env.ts";
import { type DenialRecord, fetchDenials, readHealth } from "./client.ts";
import type { RepoProxy, RepoProxyInput } from "./files.ts";
import { openLauncherCa } from "./tls-ca.ts";

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface EnsureRepoProxyOptions {
  stateDir: string;
  input: RepoProxyInput;
  env: NodeJS.ProcessEnv;
  othersLive: () => Promise<boolean>;
  runner?: CommandRunner;
  spawn?: SpawnProcess;
  timeoutMs?: number;
}

export interface RepoProxyStart {
  proxy: RepoProxy;
  notices: string[];
}

export const PROXY_LOG_LIMIT = 5 * 1024 * 1024;

const PRIVATE_MODE = 0o600;

const START_TIMEOUT_MS = 2000;

const STOP_GRACE_MS = 2000;

const POLL_MS = 50;

const TOKEN_BYTES = 32;

const CHANGED =
  "the egress settings or environment secrets changed; they apply after every session in this repository exits";

const proxyFiles = (stateDir: string, repoHash: string) => stateLayout(stateDir).repo(repoHash).proxy;

export const repoProxyToken = (stateDir: string, repoHash: string) =>
  ensureRandomHexFile(proxyFiles(stateDir, repoHash).token, TOKEN_BYTES);

export const removeRepoToken = (stateDir: string, repoHash: string) =>
  rm(proxyFiles(stateDir, repoHash).token, { force: true });

const isRecord = (value: unknown): value is RepoProxy => {
  const record = value as Partial<RepoProxy> | undefined;

  return (
    typeof record?.pid === "number" &&
    typeof record.boot === "number" &&
    typeof record.port === "number" &&
    typeof record.inputHash === "string"
  );
};

export const readRepoProxy = async (stateDir: string, repoHash: string): Promise<RepoProxy | undefined> => {
  const path = proxyFiles(stateDir, repoHash).record;
  const record = await readJsonObject(path);

  return isRecord(record) && (await isLiveFile(path, record)) ? record : undefined;
};

export const stopRepoProxy = async (stateDir: string, repoHash: string) => {
  const files = proxyFiles(stateDir, repoHash);
  const record = await readRepoProxy(stateDir, repoHash);

  if (record !== undefined) {
    await terminateProcess(record.pid, STOP_GRACE_MS);
  }

  await rm(files.record, { force: true });

  return record !== undefined;
};

const proxyInputHash = async (stateDir: string, input: RepoProxyInput) => {
  const { token: _token, envSecrets, parentAuth, ...rest } = input;
  const salt = await ensureSalt(stateDir);
  const secrets = createHmac("sha256", salt)
    .update(JSON.stringify([Object.entries(envSecrets).sort(), parentAuth ?? null]))
    .digest("hex");

  return stableHash({ ...rest, secrets });
};

const isHealthy = async (record: RepoProxy, token: string) =>
  (await readHealth(record.port, token))?.pid === record.pid;

const waitUntil = async (check: () => Promise<boolean>, deadline: number): Promise<boolean> => {
  if (await check()) {
    return true;
  }

  if (Date.now() >= deadline) {
    return false;
  }

  await sleep(POLL_MS);

  return waitUntil(check, deadline);
};

const spawnDaemon = (options: EnsureRepoProxyOptions, inputHash: string) => {
  const { stateDir, input } = options;
  const files = proxyFiles(stateDir, input.repoHash);

  capLog(files.log, PROXY_LOG_LIMIT);

  const log = openSync(files.log, "a", PRIVATE_MODE);
  const child = (options.spawn ?? spawnProcess)(
    process.execPath,
    [launcherEntry("proxy/daemon.ts"), "--repo", input.repoHash, "--state", stateDir],
    { detached: true, stdio: ["pipe", "ignore", log], env: minimalEnv(options.env) },
  );

  closeSync(log);

  child.stdin?.on("error", () => undefined);

  child.stdin?.end(JSON.stringify({ input, inputHash }));

  child.unref();

  return child;
};

const startDaemon = async (options: EnsureRepoProxyOptions, inputHash: string): Promise<RepoProxy> => {
  const { stateDir, input } = options;
  const files = proxyFiles(stateDir, input.repoHash);

  await mkdir(files.directory, { recursive: true, mode: 0o700 });

  const child = spawnDaemon(options, inputHash);
  const exited = { done: false };

  child.once("exit", () => {
    exited.done = true;
  });

  child.once("error", () => {
    exited.done = true;
  });

  const started = async () => {
    const record = await readRepoProxy(stateDir, input.repoHash);

    return record !== undefined && record.pid === child.pid && (await isHealthy(record, input.token))
      ? record
      : undefined;
  };

  await waitUntil(
    async () => exited.done || (await started()) !== undefined,
    Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS),
  );

  const record = await started();

  if (record === undefined) {
    child.kill("SIGKILL");

    throw new LauncherError("the pi-sandbox egress proxy did not become healthy", `see ${files.log}`);
  }

  return record;
};

const runningProxy = async (stateDir: string, input: RepoProxyInput) => {
  const record = await readRepoProxy(stateDir, input.repoHash);

  if (record === undefined) {
    await rm(proxyFiles(stateDir, input.repoHash).record, { force: true });

    return undefined;
  }

  if (await isHealthy(record, input.token)) {
    return record;
  }

  await stopRepoProxy(stateDir, input.repoHash);

  return undefined;
};

export const ensureRepoProxy = async (options: EnsureRepoProxyOptions): Promise<RepoProxyStart> => {
  const { stateDir, input } = options;

  await openLauncherCa({ stateDir, runner: options.runner ?? createProcessRunner() });

  const inputHash = await proxyInputHash(stateDir, input);
  const current = await runningProxy(stateDir, input);

  if (current?.inputHash === inputHash) {
    return { proxy: current, notices: [] };
  }

  if (current !== undefined && (await options.othersLive())) {
    return { proxy: current, notices: [CHANGED] };
  }

  if (current !== undefined) {
    await stopRepoProxy(stateDir, input.repoHash);
  }

  return { proxy: await startDaemon(options, inputHash), notices: [] };
};

const TOKEN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

const readToken = async (stateDir: string, repoHash: string) => {
  const text = await readFile(proxyFiles(stateDir, repoHash).token, "utf8").catch(() => "");

  return TOKEN.test(text) ? text : undefined;
};

export const readDenials = async (
  stateDir: string,
  repoHash: string,
  since: number,
): Promise<DenialRecord[]> => {
  const [record, token] = await Promise.all([
    readRepoProxy(stateDir, repoHash),
    readToken(stateDir, repoHash),
  ]);

  return record === undefined || token === undefined ? [] : fetchDenials(record.port, token, since);
};
