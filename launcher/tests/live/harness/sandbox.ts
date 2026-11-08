import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDockerEngineBackend } from "../../../backend/index.ts";
import { userHashOf } from "../../../container/index.ts";
import { stopProxy } from "../../../proxy/index.ts";
import { createProcessRunner } from "../../../shared/index.ts";
import { createTestCa, type TestCa, type TestCertificate } from "../fixtures/test-ca.ts";
import {
  engineSocket,
  listContainers,
  listNetworks,
  listVolumes,
  removeContainer,
  removeNetwork,
  removeVolume,
  startContainer,
} from "./engine.ts";
import { ALL_FIXTURE_HOSTS, resolveValue } from "./names.ts";

export interface PiResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PiRun {
  done: Promise<PiResult>;
  output(): string;
  stop(): void;
}

interface AccessEntry {
  host: string;
  decision: "allow" | "deny";
  rule: string;
  reason?: string;
}

interface PiOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface LiveSandbox {
  root: string;
  home: string;
  agentDir: string;
  stateDir: string;
  repo: string;
  repoHash: string;
  ca: TestCa;
  certificate: TestCertificate;
  env: Record<string, string>;
  writeUserConfig(config: Record<string, unknown>): Promise<void>;
  writeAgentFile(name: string, value: unknown): Promise<void>;
  readAgentFile(name: string): Promise<unknown>;
  writeFile(name: string, text: string): Promise<string>;
  pi(args: string[], options?: PiOptions): PiRun;
  exec(script: string): Promise<PiResult>;
  openedUrls(): Promise<string[]>;
  accessLog(): Promise<AccessEntry[]>;
  cleanup(): Promise<void>;
}

const run = promisify(execFile);

const LAUNCHER_ENTRY = fileURLToPath(new URL("../../../bin/pi-sandbox-dev.js", import.meta.url));

const RESOLVE_PRELOAD = fileURLToPath(new URL("../fixtures/host-pi-resolve.mjs", import.meta.url));

const DEFAULT_TIMEOUT_MS = 540_000;

const RELAY_NETWORK = "pi-sandbox";

const liveRoot = () => process.env.PI_SANDBOX_LIVE_DIR ?? join(homedir(), ".cache", "pi-sandbox-live");

export const liveEnabled = process.env.PI_SANDBOX_LIVE === "1" && engineSocket !== undefined;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const fakeOpener = (log: string) => `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`;

const initRepo = async (repo: string) => {
  await mkdir(repo, { recursive: true });

  await writeFile(join(repo, "README.md"), "pi sandbox live fixture repository\n");

  const git = (args: string[]) =>
    run("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: repo,
    });

  await git(["init", "--initial-branch=main"]);

  await git(["add", "-A"]);

  await git(["commit", "-m", "fixture"]);
};

const daemonPids = async (stateDir: string) => {
  const { stdout } = await run("ps", ["-axo", "pid=,command="]);

  return stdout
    .split("\n")
    .filter((line) => line.includes("proxy/daemon") && line.includes(stateDir))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const killAll = (pids: number[], signal: NodeJS.Signals) => {
  pids.forEach((pid) => {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  });
};

const stopDaemons = async (stateDir: string) => {
  await stopProxy(stateDir).catch(() => 0);

  killAll(await daemonPids(stateDir), "SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 500));

  killAll(await daemonPids(stateDir), "SIGKILL");
};

const readAccessLog = async (stateDir: string) => {
  const instances = await readdir(join(stateDir, "proxy")).catch(() => [] as string[]);
  const texts = await Promise.all(
    instances.map((hash) =>
      readFile(join(stateDir, "proxy", hash, "proxy-access.log"), "utf8").catch(() => ""),
    ),
  );

  return texts
    .join("\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AccessEntry);
};

const collect = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);

      callback();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

export const createLiveSandbox = async (name: string): Promise<LiveSandbox> => {
  const root = join(liveRoot(), `${name}-${randomBytes(3).toString("hex")}`);
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const stateDir = join(home, ".local", "state", "pi-sandbox");
  const userConfigFile = join(home, ".config", "pi-sandbox", "config.json");
  const repoPath = join(root, "repos", name);
  const bin = join(root, "bin");
  const certs = join(root, "certs");
  const opened = join(root, "opened.txt");
  const children = new Set<ReturnType<typeof spawn>>();
  const networkExisted = (await listNetworks()).some((network) => network.Name === RELAY_NETWORK);

  await Promise.all([agentDir, stateDir, bin, certs].map((dir) => mkdir(dir, { recursive: true })));

  await mkdir(join(home, ".config", "pi-sandbox"), { recursive: true });

  await symlink(join(homedir(), ".colima"), join(home, ".colima")).catch(() => undefined);

  await writeFile(join(bin, "open"), fakeOpener(opened));

  await writeFile(join(bin, "xdg-open"), fakeOpener(opened));

  await Promise.all([chmod(join(bin, "open"), 0o755), chmod(join(bin, "xdg-open"), 0o755)]);

  await initRepo(repoPath);

  const repo = realpathSync(repoPath);
  const repoHash = sha256(repo);
  const ca = await createTestCa(certs, "fixture-ca");
  const certificate = await ca.issue(ALL_FIXTURE_HOSTS);
  const socket = engineSocket ?? "";
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    USER: process.env.USER ?? "pi",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    PI_CODING_AGENT_DIR: agentDir,
    PI_SANDBOX_STATE_DIR: stateDir,
    PI_SANDBOX_USER_CONFIG: userConfigFile,
    PI_SANDBOX_POLICY_FILE: join(root, "no-policy.json"),
    PI_SANDBOX_TEST_RESOLVE: resolveValue(),
    NODE_OPTIONS: `--import=${RESOLVE_PRELOAD}`,
    NODE_EXTRA_CA_CERTS: ca.certPath,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const backend = createDockerEngineBackend({
    socketPath: socket,
    runner: createProcessRunner(),
  });

  const agentContainer = async () => {
    const containers = await listContainers({ "pi-sandbox.repo-hash": repoHash });

    return containers.find((container) => container.Labels["pi-sandbox.relay"] !== "true");
  };

  const pi = (args: string[], options: PiOptions = {}): PiRun => {
    const child = spawn(process.execPath, [LAUNCHER_ENTRY, ...args], {
      cwd: repo,
      env: { ...env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    children.add(child);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const done = new Promise<PiResult>((resolve) => {
      child.once("close", (code) => {
        clearTimeout(timer);

        children.delete(child);

        const result = {
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };

        console.log(`$ pi ${args.join(" ")}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);

        resolve(result);
      });
    });

    return {
      done,
      output: () => Buffer.concat([...stdout, ...stderr]).toString("utf8"),
      stop: () => {
        child.kill("SIGTERM");
      },
    };
  };

  const exec = async (script: string): Promise<PiResult> => {
    const container = await agentContainer();

    if (container === undefined) {
      return { code: 127, stdout: "", stderr: "no sandbox container" };
    }

    await startContainer(container.Id);

    const out = collect();
    const err = collect();
    const code = await backend.exec(
      { containerId: container.Id, command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdout: out.stream, stderr: err.stream, tty: false },
    );

    return { code, stdout: out.text(), stderr: err.text() };
  };

  const cleanup = async () => {
    const exited = [...children].map((child) => new Promise((resolve) => child.once("close", resolve)));

    children.forEach((child) => {
      child.kill("SIGKILL");
    });

    await Promise.all(exited);

    await stopDaemons(stateDir);

    const owned = await listContainers({ "pi-sandbox.repo-hash": repoHash });
    const instanceHashes = await readdir(join(stateDir, "proxy")).catch(() => [] as string[]);
    const policyHashes = new Set([
      ...instanceHashes,
      ...owned.map((container) => container.Labels["pi-sandbox.proxy-policy-hash"] ?? ""),
    ]);
    const relays = (await listContainers({ "pi-sandbox.relay": "true" })).filter((relay) =>
      policyHashes.has(relay.Labels["pi-sandbox.proxy-policy-hash"] ?? ""),
    );

    await Promise.all([...owned, ...relays].map((container) => removeContainer(container.Id)));

    const userHashes = [stateDir, existsSync(stateDir) ? realpathSync(stateDir) : stateDir].map(userHashOf);
    const volumes = (await listVolumes()).filter(
      (volume) =>
        volume.Name.includes(repoHash.slice(0, 12)) ||
        volume.Labels?.["pi-sandbox.repo-hash"] === repoHash ||
        userHashes.includes(volume.Labels?.["pi-sandbox.user-hash"] ?? ""),
    );
    const removals = await Promise.all(volumes.map((volume) => removeVolume(volume.Name)));
    const kept = volumes.filter((_volume, index) => ![204, 404].includes(removals[index]?.status ?? 0));

    const networks = await listNetworks();
    const repoNetworks = networks.filter(
      (candidate) => candidate.Name === `${RELAY_NETWORK}-${repoHash.slice(0, 12)}`,
    );

    await Promise.all(repoNetworks.map((candidate) => removeNetwork(candidate.Id)));

    const network = networks.find((candidate) => candidate.Name === RELAY_NETWORK);
    const attached = network === undefined ? [] : await listContainers({ "pi-sandbox.relay": "true" });

    if (network !== undefined && !networkExisted && attached.length === 0) {
      await removeNetwork(network.Id);
    }

    await rm(root, { recursive: true, force: true });

    if (kept.length > 0) {
      throw new Error(`live cleanup could not remove ${kept.map((volume) => volume.Name).join(", ")}`);
    }
  };

  return {
    root,
    home,
    agentDir,
    stateDir,
    repo,
    repoHash,
    ca,
    certificate,
    env,
    writeUserConfig: (config) => writeFile(userConfigFile, `${JSON.stringify(config, null, 2)}\n`),
    writeAgentFile: (file, value) => writeFile(join(agentDir, file), `${JSON.stringify(value, null, 2)}\n`),
    readAgentFile: async (file) => JSON.parse(await readFile(join(agentDir, file), "utf8")) as unknown,
    writeFile: async (file, text) => {
      await writeFile(join(root, file), text);

      return join(root, file);
    },
    pi,
    exec,
    openedUrls: async () =>
      existsSync(opened) ? (await readFile(opened, "utf8")).split("\n").filter((line) => line !== "") : [],
    accessLog: () => readAccessLog(stateDir),
    cleanup,
  };
};
