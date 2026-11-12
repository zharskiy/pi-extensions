import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createColimaBackend } from "../../../backend/index.ts";
import { userHashOf } from "../../../container/index.ts";
import { endLaunch, newLaunchId, registerLaunch } from "../../../grants/index.ts";
import { stopRepoProxy } from "../../../proxy/index.ts";
import { createProcessRunner, processMark, stateLayout } from "../../../shared/index.ts";
import { writeManagedPi } from "../../cli/harness.ts";
import { createTestCa, type TestCa, type TestCertificate } from "../fixtures/test-ca.ts";
import {
  engineSocket,
  listContainers,
  listNetworks,
  listVolumes,
  removeContainer,
  removeNetwork,
  removeVolume,
} from "./engine.ts";
import { ALL_FIXTURE_HOSTS, resolveValue } from "./names.ts";

interface PiResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PiRun {
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
  holdStdin?: boolean;
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
  writeFile(name: string, text: string): Promise<string>;
  pi(args: string[], options?: PiOptions): PiRun;
  exec(script: string, options?: PiOptions): Promise<PiResult>;
  session<T>(action: (containerId: string) => Promise<T>, options?: PiOptions): Promise<T>;
  accessLog(): Promise<AccessEntry[]>;
  lastExit(): Promise<PiResult>;
  leftovers(): Promise<string[]>;
  cleanup(): Promise<void>;
}

const run = promisify(execFile);

const LAUNCHER_ENTRY = fileURLToPath(new URL("../../../bin/pi-sandbox-dev.js", import.meta.url));

const REPO_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

const REPO_PI = join(REPO_MODULES, "@earendil-works", "pi-coding-agent");

const installRepoPiAsManaged = async (agentDir: string) => {
  const manifest = JSON.parse(await readFile(join(REPO_PI, "package.json"), "utf8")) as {
    version: string;
    bin: Record<string, string>;
  };

  await writeManagedPi(agentDir, manifest.version, {
    nodeModules: REPO_MODULES,
    wrapper: (packageDir) => `exec '${process.execPath}' '${join(packageDir, manifest.bin.pi ?? "")}' "$@"`,
  });
};

const resolvePreload = () => {
  const url = new URL("./resolve-preload.mjs", import.meta.url);

  url.searchParams.set("hosts", resolveValue());

  return url.href;
};

const DEFAULT_TIMEOUT_MS = 540_000;

const PI_PID_FILE = "/tmp/pi-sandbox-pi.pid";

const SESSION_START_MS = 300_000;

const SESSION_POLL_MS = 250;

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

const stopDaemons = async (stateDir: string, repoHash: string) => {
  await stopRepoProxy(stateDir, repoHash).catch(() => false);

  killAll(await daemonPids(stateDir), "SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 500));

  killAll(await daemonPids(stateDir), "SIGKILL");
};

const readAccessLog = async (stateDir: string) => {
  const repos = await readdir(stateLayout(stateDir).repos).catch(() => [] as string[]);
  const logs = repos.flatMap((hash) => {
    const log = stateLayout(stateDir).repo(hash).proxy.accessLog;

    return [`${log}.1`, log];
  });
  const texts = await Promise.all(logs.map((log) => readFile(log, "utf8").catch(() => "")));

  return texts
    .join("\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AccessEntry);
};

const nonEmptyList = async (path: string) => {
  const text = await readFile(path, "utf8").catch(() => "[]");
  const value = JSON.parse(text) as unknown;

  return Array.isArray(value) && value.length === 0 ? [] : [`${path}: ${text.trim()}`];
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
  const stateDir = join(agentDir, "pi-sandbox", "state");
  const userConfigFile = join(agentDir, "pi-sandbox", "config.json");
  const repoPath = join(root, "repos", name);
  const bin = join(root, "bin");
  const certs = join(root, "certs");
  const opened = join(root, "opened.txt");
  const children = new Set<ReturnType<typeof spawn>>();

  await Promise.all([agentDir, stateDir, bin, certs].map((dir) => mkdir(dir, { recursive: true })));

  await mkdir(join(agentDir, "pi-sandbox"), { recursive: true });

  await installRepoPiAsManaged(agentDir);

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
    NODE_OPTIONS: `--import=${resolvePreload()}`,
    NODE_EXTRA_CA_CERTS: ca.certPath,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const launchId = newLaunchId();
  await registerLaunch(stateDir, {
    launchId,
    ...(await processMark()),
    repoHash,
    startedAt: Date.now(),
  });

  const holder = { released: false };
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socket,
    runner: createProcessRunner(),
  });

  const pi = (args: string[], options: PiOptions = {}): PiRun => {
    const child = spawn(process.execPath, [LAUNCHER_ENTRY, ...args], {
      cwd: repo,
      env: { ...env, ...options.env },
      stdio: [options.holdStdin === true ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    children.add(child);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));

    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

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

  const runIn = async (containerId: string, script: string): Promise<PiResult> => {
    const out = collect();
    const err = collect();
    const code = await backend.exec(
      { containerId, command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdout: out.stream, stderr: err.stream, tty: false },
    );

    return { code, stdout: out.text(), stderr: err.text() };
  };

  const runningPi = async (run: PiRun, deadline: number): Promise<string> => {
    const containers = await listContainers({ "pi-sandbox.repo-hash": repoHash });
    const agents = containers.filter(
      (container) => container.Labels["pi-sandbox.relay"] !== "true" && container.State === "running",
    );
    const started = await Promise.all(
      agents.map(async (container) =>
        (await runIn(container.Id, `test -e ${PI_PID_FILE}`)).code === 0 ? [container.Id] : [],
      ),
    );
    const [id] = started.flat();

    if (id !== undefined) {
      return id;
    }

    if (Date.now() > deadline) {
      throw new Error(`no launch container ran pi in time:\n${run.output()}`);
    }

    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));

    return runningPi(run, deadline);
  };

  const session = async <T>(action: (containerId: string) => Promise<T>, options: PiOptions = {}) => {
    const held = pi(["-p"], { ...options, holdStdin: true });
    const ended = held.done.then((result) => {
      throw new Error(
        `the held pi session ended early (exit ${result.code}):\n${result.stdout}${result.stderr}`,
      );
    });

    try {
      const id = await Promise.race([runningPi(held, Date.now() + SESSION_START_MS), ended]);

      return await action(id);
    } finally {
      ended.catch(() => undefined);

      held.stop();

      await held.done;
    }
  };

  const exec = (script: string, options: PiOptions = {}) => session((id) => runIn(id, script), options);

  const release = async () => {
    if (holder.released) {
      return;
    }

    holder.released = true;

    await endLaunch(stateDir, { repoHash, launchId, onLast: async () => undefined });
  };

  const lastExit = async () => {
    await release();

    return pi(["list"]).done;
  };

  const leftovers = async () => {
    const files = stateLayout(stateDir).repo(repoHash);
    const owned = await listContainers({ "pi-sandbox.repo-hash": repoHash });
    const networks = (await listNetworks()).filter(
      (candidate) => candidate.Name === `pi-sandbox-${repoHash.slice(0, 12)}`,
    );
    const daemons = await daemonPids(stateDir);
    const launches = await readdir(files.launches).catch(() => [] as string[]);
    const present = await Promise.all(
      [files.proxy.record, files.proxy.token].map((path) => (existsSync(path) ? [path] : [])),
    );
    const lists = await nonEmptyList(files.created);

    return {
      containers: owned,
      networks,
      named: [
        ...owned.map((container) => `container ${container.Names.join(",")}`),
        ...networks.map((candidate) => `network ${candidate.Name}`),
        ...daemons.map((pid) => `proxy pid ${pid}`),
        ...launches.map((name) => `launch entry ${name}`),
        ...present.flat(),
        ...lists,
      ],
    };
  };

  const cleanup = async () => {
    const exited = [...children].map((child) => new Promise((resolve) => child.once("close", resolve)));

    children.forEach((child) => {
      child.kill("SIGKILL");
    });

    await Promise.all(exited);

    await lastExit();

    const left = await leftovers();

    await stopDaemons(stateDir, repoHash);

    await Promise.all(left.containers.map((container) => removeContainer(container.Id)));

    await Promise.all(left.networks.map((candidate) => removeNetwork(candidate.Id)));

    const userHashes = [stateDir, existsSync(stateDir) ? realpathSync(stateDir) : stateDir].map(userHashOf);
    const volumes = (await listVolumes()).filter(
      (volume) =>
        volume.Name.includes(repoHash.slice(0, 12)) ||
        volume.Labels?.["pi-sandbox.repo-hash"] === repoHash ||
        userHashes.includes(volume.Labels?.["pi-sandbox.user-hash"] ?? ""),
    );
    const removals = await Promise.all(volumes.map((volume) => removeVolume(volume.Name)));
    const kept = volumes.filter((_volume, index) => ![204, 404].includes(removals[index]?.status ?? 0));

    await rm(root, { recursive: true, force: true });

    if (left.named.length > 0) {
      throw new Error(`the last session left ${left.named.join(", ")}; cleanup had to remove them`);
    }

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
    writeFile: async (file, text) => {
      await writeFile(join(root, file), text);

      return join(root, file);
    },
    pi,
    exec,
    session,
    accessLog: () => readAccessLog(stateDir),
    lastExit,
    leftovers: async () => (await leftovers()).named,
    cleanup,
  };
};
