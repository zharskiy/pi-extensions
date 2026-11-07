import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { get, request as httpRequest } from "node:http";
import type { EgressCap, SandboxConfig } from "../config/index.ts";
import {
  type CommandRunner,
  createProcessRunner,
  errorMessage,
  LauncherError,
  launcherEntry,
  readJsonFile,
  writeJsonFile,
} from "../shared/index.ts";
import { controlAuthorization } from "./auth.ts";
import { type DaemonConfig, type ProxyInstance, proxyFiles, proxyRoot } from "./files.ts";
import { proxyPolicyHash } from "./settings.ts";
import { openLauncherCa } from "./tls-ca.ts";

export interface EnvSecretsMessage {
  type: "env-secrets";
  secrets: Record<string, string>;
}

export type ControlMessage = EnvSecretsMessage;

export type ControlReply = { ok: true } | { ok: false; error: string };

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

type InstanceFiles = ReturnType<typeof proxyFiles>;

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
  egressCap?: EgressCap;
  piCommand?: string[];
}

interface Health {
  ok: boolean;
  policyHash: string;
  pid: number;
}

const LISTEN_HOST = "127.0.0.1";

const PRIVATE_MODE = 0o600;

const HEALTH_TIMEOUT_MS = 500;

const START_TIMEOUT_MS = 2000;

const STOP_TIMEOUT_MS = 2000;

const LOCK_TIMEOUT_MS = 10_000;

const POLL_MS = 50;

const TOKEN_BYTES = 32;

const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readHealth = (instance: ProxyInstance) =>
  new Promise<Health | undefined>((resolve) => {
    const request = get(
      {
        host: LISTEN_HOST,
        port: instance.port,
        path: "/healthz",
        timeout: HEALTH_TIMEOUT_MS,
        headers: { "proxy-authorization": controlAuthorization(instance.token) },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));

        response.on("end", () => {
          try {
            const health = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Health;

            resolve(response.statusCode === 200 && health.ok === true ? health : undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );

    request.on("timeout", () => request.destroy());

    request.on("error", () => resolve(undefined));
  });

const readRecord = (files: InstanceFiles) => readJsonFile<ProxyInstance>(files.record).catch(() => undefined);

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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
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
  if (!isAlive(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");

  const stopped = await waitUntil(async () => !isAlive(pid), now() + STOP_TIMEOUT_MS, now);

  if (!stopped) {
    process.kill(pid, "SIGKILL");
  }
};

export interface LockSnapshot {
  owner: number;
  text: string;
  ino: number;
  mtimeMs: number;
}

const lockSnapshot = async (path: string): Promise<LockSnapshot | undefined> => {
  const handle = await open(path, "r").catch(() => undefined);

  if (handle === undefined) {
    return undefined;
  }

  try {
    const info = await handle.stat();
    const text = await handle.readFile("utf8");

    return { owner: Number.parseInt(text, 10), text, ino: info.ino, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
};

const sameLock = (left: LockSnapshot | undefined, right: LockSnapshot) =>
  left !== undefined && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.text === right.text;

const uniqueSibling = (path: string, kind: string) =>
  `${path}.${kind}.${process.pid}.${randomBytes(4).toString("hex")}`;

const createLock = async (path: string) => {
  const staged = uniqueSibling(path, "staged");

  await writeFile(staged, String(process.pid), { mode: PRIVATE_MODE });

  try {
    await link(staged, path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new LauncherError(`cannot lock ${path}: ${errorMessage(error)}`);
    }

    return false;
  } finally {
    await rm(staged, { force: true });
  }
};

const isLiveOwner = (owner: number) => Number.isInteger(owner) && isAlive(owner);

export const takeOverStaleLock = async (path: string, stale: LockSnapshot) => {
  const moved = uniqueSibling(path, "stale");
  const renamed = await rename(path, moved).then(
    () => true,
    () => false,
  );

  if (!renamed) {
    return;
  }

  const found = await lockSnapshot(moved);

  if (found !== undefined && !sameLock(found, stale) && isLiveOwner(found.owner)) {
    await link(moved, path).catch(() => undefined);
  }

  await rm(moved, { force: true });
};

const acquireLock = async (path: string, deadline: number, now: () => number): Promise<void> => {
  if (await createLock(path)) {
    return;
  }

  const snapshot = await lockSnapshot(path);
  const owner = snapshot?.owner ?? Number.NaN;

  if (snapshot !== undefined && !isLiveOwner(owner)) {
    await takeOverStaleLock(path, snapshot);

    return acquireLock(path, deadline, now);
  }

  if (snapshot === undefined) {
    return acquireLock(path, deadline, now);
  }

  if (now() >= deadline) {
    throw new LauncherError(
      `another launcher (pid ${owner}) is starting the egress proxy`,
      `wait for it, or remove ${path} if that process is gone`,
    );
  }

  await delay(POLL_MS);

  return acquireLock(path, deadline, now);
};

const withLock = async <T>(files: InstanceFiles, now: () => number, action: () => Promise<T>) => {
  await mkdir(files.directory, { recursive: true, mode: 0o700 });

  await acquireLock(files.lock, now() + LOCK_TIMEOUT_MS, now);

  try {
    return await action();
  } finally {
    await rm(files.lock, { force: true });
  }
};

const instanceDirectories = async (stateDir: string) => {
  const entries = await readdir(proxyRoot(stateDir), { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

export const readProxyInstances = async (stateDir: string) => {
  const hashes = await instanceDirectories(stateDir);
  const records = await Promise.all(hashes.map((hash) => healthyRecord(proxyFiles(stateDir, hash))));

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
  const files = proxyFiles(stateDir, policyHash);
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
    hashes.map((hash) => stopInstance(proxyFiles(stateDir, hash), hash, runner)),
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
    { detached: true, stdio: ["ignore", "ignore", log], env: options.env },
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
  }

  return record;
};

const respondsTwice = async (record: ProxyInstance) => {
  if (await isHealthy(record)) {
    return true;
  }

  await delay(POLL_MS);

  return isHealthy(record);
};

const instanceToken = async (files: InstanceFiles) => {
  const stored = await readFile(files.token, "utf8").catch(() => "");

  if (TOKEN_PATTERN.test(stored)) {
    return stored;
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");

  await rm(files.token, { force: true });

  await writeFile(files.token, token, { mode: PRIVATE_MODE });

  return token;
};

const replaceInstance = async (options: EnsureProxyOptions, files: InstanceFiles, hash: string) => {
  const now = options.now ?? Date.now;
  const runner = options.runner ?? createProcessRunner();
  const stale = await readRecord(files);

  if (stale !== undefined && (await respondsTwice(stale))) {
    return stale;
  }

  if (stale !== undefined && (await isProxyProcess(runner, stale.pid, hash))) {
    await terminate(stale.pid, now);
  }

  const daemonConfig: DaemonConfig<SandboxConfig> = {
    token: await instanceToken(files),
    config: options.config,
    egressCap: options.egressCap ?? {},
    piCommand: options.piCommand ?? [],
  };

  await writeJsonFile(files.config, daemonConfig, { mode: PRIVATE_MODE });

  const preferred = options.port ?? stale?.port ?? 0;
  const started =
    (await launchDaemon(options, files, preferred, hash)) ??
    (preferred === 0 || options.port !== undefined ? undefined : await launchDaemon(options, files, 0, hash));

  if (started === undefined) {
    throw new LauncherError("the pi-sandbox egress proxy did not become healthy", `see ${files.proxyLog}`);
  }

  return started;
};

export const ensureProxyRunning = async (options: EnsureProxyOptions): Promise<ProxyInstance> => {
  const hash = proxyPolicyHash(options.config, options.egressCap);
  const files = proxyFiles(options.stateDir, hash);

  await openLauncherCa({ stateDir: options.stateDir, runner: options.runner ?? createProcessRunner() });

  const current = await healthyRecord(files);

  if (current !== undefined) {
    return current;
  }

  return withLock(files, options.now ?? Date.now, () => replaceInstance(options, files, hash));
};

const CONTROL_TIMEOUT_MS = 2000;

const parseReply = (text: string): ControlReply => {
  try {
    const reply = JSON.parse(text) as ControlReply;

    return typeof reply === "object" && reply !== null && typeof reply.ok === "boolean"
      ? reply
      : { ok: false, error: "the proxy sent an unreadable reply" };
  } catch {
    return { ok: false, error: "the proxy sent an unreadable reply" };
  }
};

export const sendProxyControl = (instance: ProxyInstance, message: ControlMessage) =>
  new Promise<ControlReply>((resolve) => {
    const body = JSON.stringify(message);
    const request = httpRequest(
      {
        host: LISTEN_HOST,
        port: instance.port,
        method: "POST",
        path: "/control",
        timeout: CONTROL_TIMEOUT_MS,
        headers: {
          "proxy-authorization": controlAuthorization(instance.token),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));

        response.on("end", () => resolve(parseReply(Buffer.concat(chunks).toString("utf8"))));
      },
    );

    request.on("timeout", () => request.destroy());

    request.on("error", (error) => resolve({ ok: false, error: `cannot reach the proxy: ${error.message}` }));

    request.end(body);
  });
