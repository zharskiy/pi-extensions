import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { Backend } from "../../backend/index.ts";
import type { CliDeps } from "../../cli/index.ts";
import type { ProxyInstance } from "../../proxy/index.ts";
import type { RunResult } from "../../shared/index.ts";
import { createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";

interface Collected {
  stream: NodeJS.WritableStream;
  text(): string;
}

export interface HarnessOptions {
  adapters?: () => Backend[];
  proxy?: Partial<CliDeps["proxy"]>;
  respond?: FakeResponder;
  env?: Record<string, string>;
}

const collector = (): Collected => {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      chunks.push(chunk.toString());

      done();
    },
  });

  return { stream, text: () => chunks.join("") };
};

const TARBALL = "pi-extensions-mz-0.4.0.tgz";

const RUNNING_PROXY: ProxyInstance = { pid: 4242, port: 3128, policyHash: "policy", token: "token-1" };

const gitAnswer = (repoRoot: string, args: string[]): Partial<RunResult> | undefined => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
    return { stdout: `${repoRoot}\n${join(repoRoot, ".git")}\n` };
  }

  return args[0] === "rev-parse" && args[1] === "HEAD" ? { stdout: "head-one\n" } : undefined;
};

const npmPack = (args: string[]): Partial<RunResult> => {
  const outDir = args[2] ?? "";

  writeFileSync(join(outDir, TARBALL), "tarball");

  return { stdout: `${TARBALL}\n` };
};

export const createHarness = async (options: HarnessOptions = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-cli-")));
  const repoRoot = join(root, "repo");
  const cwd = join(repoRoot, "src");
  const stateDir = join(root, "state");
  const userConfigFile = join(root, "config", "config.json");
  const policyFile = join(root, "policy.json");

  mkdirSync(join(repoRoot, ".git", "hooks"), { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const stdout = collector();
  const stderr = collector();
  const fake = createFakeRunner((call) => {
    const custom = options.respond?.(call);

    if (custom !== undefined) {
      return custom;
    }

    if (call.interactive) {
      return { code: 0 };
    }

    if (call.file === "git") {
      return gitAnswer(repoRoot, call.args);
    }

    return call.file === "npm" && call.args[0] === "pack" ? npmPack(call.args) : undefined;
  });
  const terminalOut = new PassThrough();
  const stoppedProxies: Array<string | undefined> = [];
  const removedProxies: string[] = [];
  const deps: CliDeps = {
    runner: fake.runner,
    env: {
      PI_SANDBOX_STATE_DIR: stateDir,
      PI_SANDBOX_USER_CONFIG: userConfigFile,
      PI_SANDBOX_POLICY_FILE: policyFile,
      USER: "dev",
      TERM: "xterm-256color",
      PATH: "",
      ...options.env,
    },
    home: join(root, "home"),
    cwd,
    stdout: stdout.stream,
    stderr: stderr.stream,
    terminal: {
      stdin: new PassThrough(),
      stdout: terminalOut,
      stderr: new PassThrough(),
      columns: 120,
      rows: 40,
      onResize: () => () => undefined,
    },
    platform: "darwin",
    uid: 501,
    gid: 20,
    adapters: options.adapters ?? (() => []),
    proxy: {
      ensure: async () => RUNNING_PROXY,
      list: async () => [],
      stop: async (_stateDir, policyHash) => {
        stoppedProxies.push(policyHash);

        return 1;
      },
      remove: async (_stateDir, policyHash) => {
        removedProxies.push(policyHash);

        return true;
      },
      ensureCa: async () => ({ certPemPath: join(stateDir, "ca", "ca.pem") }),
      ...options.proxy,
    },
    now: () => 1_700_000_000_000,
  };

  const writeJson = async (file: string, value: unknown) => {
    await mkdir(join(file, ".."), { recursive: true });

    await writeFile(file, JSON.stringify(value));
  };

  return {
    root,
    repoRoot,
    cwd,
    stateDir,
    userConfigFile,
    policyFile,
    deps,
    calls: fake.calls,
    stoppedProxies,
    removedProxies,
    stdout: stdout.text,
    stderr: stderr.text,
    writeJson,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};
