import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { SandboxConfig } from "../config/index.ts";
import {
  type CommandRunner,
  createProcessRunner,
  ensureRandomHexFile,
  hostAgentDir,
  isProcessAlive,
  LauncherError,
  launcherEntry,
  readJsonObject,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import { minimalEnv, parentProxyEnv } from "./child-env.ts";
import { readHealth } from "./client.ts";
import type { DaemonConfig, ProxyInstance } from "./files.ts";
import { proxyPolicyHash } from "./settings.ts";
import { openLauncherCa } from "./tls-ca.ts";

export type { ControlMessage, ControlReply } from "./client.ts";

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

type InstanceFiles = ReturnType<ReturnType<typeof stateLayout>["proxyInstance"]>;

export interface EnsureProxyOptions {
  stateDir: string;
  config: SandboxConfig;
  env: NodeJS.ProcessEnv;
  home: string;
  now?: () => number;
  spawn?: SpawnProcess;
  runner?: CommandRunner;
  port?: number;
  timeoutMs?: number;
  piCommand?: string[];
  piVersion?: string;
}

const PRIVATE_MODE = 0o600;

const START_TIMEOUT_MS = 2000;

const STOP_TIMEOUT_MS = 2000;

const LOCK_TIMEOUT_MS = 10_000;

const POLL_MS = 50;

const TOKEN_BYTES = 32;

const DAEMON_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_SANDBOX_STATE_DIR",
  "PI_SANDBOX_USER_CONFIG",
  "PI_SANDBOX_POLICY_FILE",
];

const pickEnv = (env: NodeJS.ProcessEnv, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));

export const daemonEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...pickEnv(env, DAEMON_ENV_KEYS),
  ...parentProxyEnv(env),
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readRecord = async (files: InstanceFiles) =>
  (await readJsonObject(files.record)) as ProxyInstance | undefined;

const isHealthy = async (instance: ProxyInstance | undefined) => {
  if (instance === undefined) {
    return false;
  }

  const health = await readHealth(instance);

  return health?.pid === instance.pid && health.policyHash === instance.policyHash;
};

const healthyRecord = async (files: InstanceFiles) => {
  const record = await readRecord(files);

  return (await isHealthy(record)) ? record : undefined;
};

const recordedPort = async (files: InstanceFiles) => {
  const port = Number.parseInt(await readFile(files.port, "utf8").catch(() => ""), 10);

  return Number.isInteger(port) && port > 0 ? port : undefined;
};

const waitUntil = async (check: () => Promise<boolean>, deadline: number, now: () => number) => {
  if (await check()) {
    return true;
  }

  if (now() >= deadline) {
    return false;
  }

  await delay(POLL_MS);

  return waitUntil(check, deadline, now);
};

const terminate = async (pid: number, now: () => number) => {
  if (!isProcessAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");

  const stopped = await waitUntil(async () => !isProcessAlive(pid), now() + STOP_TIMEOUT_MS, now);

  if (!stopped) {
    process.kill(pid, "SIGKILL");
  }
};

const withLock = async <T>(files: InstanceFiles, action: () => Promise<T>) => {
  await mkdir(files.directory, { recursive: true, mode: 0o700 });

  return withFileLock(files.lock, action, { timeoutMs: LOCK_TIMEOUT_MS });
};

const instanceDirectories = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).proxyRoot, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

export const readProxyInstances = async (stateDir: string) => {
  const hashes = await instanceDirectories(stateDir);
  const records = await Promise.all(
    hashes.map((hash) => healthyRecord(stateLayout(stateDir).proxyInstance(hash))),
  );

  return records.filter((record): record is ProxyInstance => record !== undefined);
};

const isProxyProcess = async (runner: CommandRunner, pid: number, hash: string) => {
  const result = await runner.run("ps", ["-o", "command=", "-p", String(pid)]).catch(() => undefined);
  const command = result?.stdout ?? "";

  return command.includes("proxy/daemon") && command.includes(hash);
};

const stopInstance = async (files: InstanceFiles, hash: string, runner: CommandRunner) => {
  const record = await readRecord(files);
  const running =
    record !== undefined && ((await isHealthy(record)) || (await isProxyProcess(runner, record.pid, hash)));

  if (running) {
    await terminate(record.pid, Date.now);
  }

  await rm(files.record, { force: true });

  await rm(files.config, { force: true });

  return running;
};

export const removeProxyInstance = async (stateDir: string, policyHash: string) => {
  const files = stateLayout(stateDir).proxyInstance(policyHash);
  const found = await stat(files.directory).then(
    () => true,
    () => false,
  );

  if (!found) {
    return false;
  }

  await stopInstance(files, policyHash, createProcessRunner());

  await rm(files.directory, { recursive: true, force: true });

  return true;
};

export const stopProxy = async (stateDir: string, policyHash?: string) => {
  const runner = createProcessRunner();
  const hashes = policyHash === undefined ? await instanceDirectories(stateDir) : [policyHash];
  const stopped = await Promise.all(
    hashes.map((hash) => stopInstance(stateLayout(stateDir).proxyInstance(hash), hash, runner)),
  );

  return stopped.filter(Boolean).length;
};

const launchDaemon = async (
  options: EnsureProxyOptions,
  files: InstanceFiles,
  port: number,
  hash: string,
) => {
  const now = options.now ?? Date.now;
  const spawn = options.spawn ?? spawnProcess;
  const log = openSync(files.proxyLog, "a", PRIVATE_MODE);
  const child = spawn(
    process.execPath,
    [
      launcherEntry("proxy/daemon.ts"),
      "--hash",
      hash,
      "--port",
      String(port),
      "--state",
      options.stateDir,
      "--home",
      options.home,
    ],
    { detached: true, stdio: ["ignore", "ignore", log], env: minimalEnv(options.env) },
  );
  const exited = { done: false };

  closeSync(log);

  child.once("exit", () => {
    exited.done = true;
  });

  child.once("error", () => {
    exited.done = true;
  });

  child.unref();

  const started = async () => {
    const record = await readRecord(files);

    return record?.pid === child.pid && (await isHealthy(record)) ? record : undefined;
  };

  await waitUntil(
    async () => exited.done || (await started()) !== undefined,
    now() + (options.timeoutMs ?? START_TIMEOUT_MS),
    now,
  );

  const record = await started();

  if (record === undefined) {
    child.kill("SIGKILL");

    return undefined;
  }

  await writeFile(files.port, String(record.port), { mode: PRIVATE_MODE });

  return record;
};

const respondsTwice = async (record: ProxyInstance) => {
  if (await isHealthy(record)) {
    return true;
  }

  await delay(POLL_MS);

  return isHealthy(record);
};

const sameList = (stored: unknown, wanted: string[]) =>
  Array.isArray(stored) &&
  stored.length === wanted.length &&
  stored.every((item, index) => item === wanted[index]);

const runsSamePi = async (files: InstanceFiles, options: EnsureProxyOptions) => {
  const stored = await readJsonObject(files.config);

  return (
    stored !== undefined &&
    stored.piVersion === options.piVersion &&
    sameList(stored.piCommand, options.piCommand ?? []) &&
    stored.hostAgentDir === hostAgentDir(options.home, options.env)
  );
};

const instanceToken = (files: InstanceFiles) => ensureRandomHexFile(files.token, TOKEN_BYTES);

const replaceInstance = async (options: EnsureProxyOptions, files: InstanceFiles, hash: string) => {
  const now = options.now ?? Date.now;
  const runner = options.runner ?? createProcessRunner();
  const stale = await readRecord(files);

  if (stale !== undefined && (await runsSamePi(files, options)) && (await respondsTwice(stale))) {
    return stale;
  }

  if (stale !== undefined && (await isProxyProcess(runner, stale.pid, hash))) {
    await terminate(stale.pid, now);
  }

  const daemonConfig: DaemonConfig<SandboxConfig> = {
    token: await instanceToken(files),
    config: options.config,
    piCommand: options.piCommand ?? [],
    hostAgentDir: hostAgentDir(options.home, options.env),
    ...(options.piVersion === undefined ? {} : { piVersion: options.piVersion }),
    parentEnv: parentProxyEnv(options.env),
  };

  await writeJsonFile(files.config, daemonConfig, { mode: PRIVATE_MODE });

  const preferred = options.port ?? stale?.port ?? (await recordedPort(files)) ?? 0;
  const started =
    (await launchDaemon(options, files, preferred, hash)) ??
    (preferred === 0 || options.port !== undefined ? undefined : await launchDaemon(options, files, 0, hash));

  if (started === undefined) {
    throw new LauncherError("the pi-sandbox egress proxy did not become healthy", `see ${files.proxyLog}`);
  }

  return started;
};

export const ensureProxyRunning = async (options: EnsureProxyOptions): Promise<ProxyInstance> => {
  const hash = proxyPolicyHash(options.config);
  const files = stateLayout(options.stateDir).proxyInstance(hash);

  await openLauncherCa({ stateDir: options.stateDir, runner: options.runner ?? createProcessRunner() });

  const current = await healthyRecord(files);

  if (current !== undefined && (await runsSamePi(files, options))) {
    return current;
  }

  return withLock(files, () => replaceInstance(options, files, hash));
};
