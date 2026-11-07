import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach } from "vitest";
import type { Backend, ExecSpec } from "../../backend/index.ts";
import type { CliDeps } from "../../cli/index.ts";
import { piVersion } from "../../cli/versions.ts";
import type { BundledPi } from "../../hostpi/index.ts";
import type { ControlMessage, DenialRecord, ProxyInstance } from "../../proxy/index.ts";
import { type RunResult, sha256Hex, stateLayout } from "../../shared/index.ts";
import type { FakeExec } from "../support/fake-backend.ts";
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
  bundledPi?: BundledPi | null;
  providerHosts?: Record<string, { hosts: string[]; envVars?: string[] }>;
  denials?: DenialRecord[];
  resolve?: (host: string) => Promise<string[]>;
  confirm?: boolean;
}

const roots: string[] = [];

const removeRoot = (root: string) => rm(root, { recursive: true, force: true });

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

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

const FAKE_PI_DIR = "/fake/node_modules/@earendil-works/pi-coding-agent";

const PROVIDER_HOSTS = { example: { hosts: ["models.example.test"] } };

const isProviderHostsScript = (call: { file: string; args: string[] }) =>
  call.file === process.execPath && (call.args[0] ?? "").endsWith("provider-hosts.mjs");

const withoutOptions = (args: string[]): string[] =>
  args[0] === "-c" ? withoutOptions(args.slice(2)) : args;

const gitAnswer = (repoRoot: string, given: string[]): Partial<RunResult> | undefined => {
  const args = withoutOptions(given);

  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
    return { stdout: `${repoRoot}\n${join(repoRoot, ".git")}\n` };
  }

  if (args[0] === "status") {
    return { stdout: "" };
  }

  return args[0] === "rev-parse" && args[1] === "HEAD" ? { stdout: "head-one\n" } : undefined;
};

const npmPack = (args: string[]): Partial<RunResult> => {
  const outDir = args[2] ?? "";

  writeFileSync(join(outDir, TARBALL), "tarball");

  return { stdout: `${TARBALL}\n` };
};

interface HarnessPaths {
  stateDir: string;
  repoRoot: string;
}

interface DynamicSection {
  rules: unknown[];
  derivedHosts: string[];
  vault?: Array<{ server: string; discovery: { hosts: string[] } }>;
}

export const isPiSession = (spec: ExecSpec) => spec.env.PI_SANDBOX_LAUNCH_ID !== undefined;

export const piSessions = (fake: { execs: FakeExec[] }) =>
  fake.execs.filter((exec) => isPiSession(exec.spec));

export const piSession = (fake: { execs: FakeExec[] }) => piSessions(fake).at(-1);

export const renderDirOf = (harness: HarnessPaths) =>
  stateLayout(harness.stateDir).render(sha256Hex(harness.repoRoot));

export const repoTokenOf = (harness: HarnessPaths, policyHash = RUNNING_PROXY.policyHash) =>
  readFile(
    stateLayout(harness.stateDir).proxyInstance(policyHash).repoToken(sha256Hex(harness.repoRoot)),
    "utf8",
  );

export const repoDynamicOf = async (harness: HarnessPaths, policyHash = RUNNING_PROXY.policyHash) => {
  const files = stateLayout(harness.stateDir).proxyInstance(policyHash);
  const stored = JSON.parse(await readFile(files.dynamic, "utf8")) as {
    repos: Record<string, DynamicSection>;
  };

  return stored.repos[sha256Hex(await repoTokenOf(harness, policyHash))];
};

export const createHarness = async (options: HarnessOptions = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-cli-")));

  roots.push(root);

  const repoRoot = join(root, "repo");
  const cwd = join(repoRoot, "src");
  const stateDir = join(root, "state");
  const userConfigFile = join(root, "config", "config.json");
  const policyFile = join(root, "policy.json");

  const hostAgentDir = join(root, "home", ".pi", "agent");
  const trustPem = join(stateDir, "ca", "trust.pem");

  mkdirSync(join(repoRoot, ".git", "hooks"), { recursive: true });

  mkdirSync(join(stateDir, "ca"), { recursive: true });

  writeFileSync(trustPem, "trust bundle\n");

  writeFileSync(join(stateDir, "ca", "extra.pem"), "");
  mkdirSync(cwd, { recursive: true });

  const stdout = collector();
  const stderr = collector();
  const fake = createFakeRunner((call) => {
    const custom = options.respond?.(call);

    if (custom !== undefined) {
      return custom;
    }

    if (isProviderHostsScript(call)) {
      return { stdout: JSON.stringify(options.providerHosts ?? PROVIDER_HOSTS) };
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
  const controlMessages: ControlMessage[] = [];
  const questions: string[] = [];
  const bundledPi =
    options.bundledPi === null
      ? undefined
      : (options.bundledPi ?? {
          command: [process.execPath, join(FAKE_PI_DIR, "dist", "cli.js")],
          version: await piVersion(),
          packageDir: FAKE_PI_DIR,
        });
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
      control: async (_instance, message) => {
        controlMessages.push(message);

        return { ok: true };
      },
      denials: async () => options.denials ?? [],
      trust: async () => ({
        pemPath: trustPem,
        extraPemPath: join(stateDir, "ca", "extra.pem"),
        hash: "trust-hash",
      }),
      ...options.proxy,
    },
    bundledPi: async () => bundledPi,
    resolveHost: options.resolve ?? (async () => []),
    confirm: async (question) => {
      questions.push(question);

      return options.confirm ?? false;
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
    hostAgentDir,
    trustPem,
    userConfigFile,
    policyFile,
    deps,
    calls: fake.calls,
    stoppedProxies,
    removedProxies,
    controlMessages,
    questions,
    stdout: stdout.text,
    stderr: stderr.text,
    writeJson,
    cleanup: () => removeRoot(root),
  };
};
