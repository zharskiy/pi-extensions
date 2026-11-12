import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach } from "vitest";
import type { Backend, ExecSpec } from "../../backend/index.ts";
import { pathsOf } from "../../cli/deps.ts";
import type { CliDeps } from "../../cli/index.ts";
import { sweepOrphans } from "../../cli/sweep.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { newLaunchId, registerLaunch } from "../../grants/index.ts";
import type { DenialRecord, RepoProxy, RepoProxyInput } from "../../proxy/index.ts";
import { LauncherError, processMark, type RunResult, sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend as createBareBackend, type FakeExec } from "../support/fake-backend.ts";
import { createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";

interface Collected {
  stream: NodeJS.WritableStream;
  text(): string;
}

export interface HarnessOptions {
  backend?: () => Backend;
  proxy?: Partial<CliDeps["proxy"]>;
  respond?: FakeResponder;
  env?: Record<string, string>;
  hostPi?: false;
  providerHosts?: Record<string, { hosts: string[]; envVars?: string[] }>;
  denials?: DenialRecord[];
  machine?: CliDeps["machine"];
}

const roots: string[] = [];

export const unreachable = (backend: Backend): Backend => ({
  ...backend,
  detect: async () => ({ available: false, reason: "socket missing" }),
  vm: {
    ...backend.vm,
    ensureRunning: async () => {
      throw new LauncherError(
        "the sandbox VM engine is unreachable at ~/.colima/pi-sandbox/docker.sock: socket missing",
        "run launcher/install.sh or colima start --profile pi-sandbox --activate=false",
      );
    },
  },
});

type FakeBackendOptions = NonNullable<Parameters<typeof createBareBackend>[0]>;

export const createFakeBackend = (options: FakeBackendOptions = {}) => {
  const guestAgentDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-guest-")));

  roots.push(guestAgentDir);

  return createBareBackend({ guestAgentDir, ...options });
};

const unreachableBackend = () => unreachable(createFakeBackend().backend);

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

const RUNNING_PROXY: RepoProxy = { pid: 4242, boot: 0, start: "", port: 3128, inputHash: "input" };

const PROVIDER_HOSTS = { example: { hosts: ["models.example.test"] } };

const isProviderHostsScript = (call: { file: string; args: string[] }) =>
  call.file === process.execPath && (call.args[0] ?? "").endsWith("provider-hosts.mjs");

export const isTlsProbeScript = (call: { file: string; args: string[] }) =>
  call.file === process.execPath &&
  call.args[0] === "-e" &&
  (call.args[1] ?? "").includes("getPeerCertificate");

const NOT_INSPECTED = JSON.stringify({ chain: [], verdicts: [null] });

const withoutOptions = (args: string[]): string[] =>
  args[0] === "-c" ? withoutOptions(args.slice(2)) : args;

const gitAnswer = (repoRoot: string, given: string[]): Partial<RunResult> | undefined => {
  const args = withoutOptions(given);

  return args[0] === "rev-parse" && args[1] === "--show-toplevel"
    ? { stdout: `${repoRoot}\n${join(repoRoot, ".git")}\n` }
    : undefined;
};

interface HarnessPaths {
  stateDir: string;
  repoRoot: string;
}

export const isPiSession = (spec: ExecSpec) => spec.env.PI_SANDBOX_LAUNCH_ID !== undefined;

export const piSessions = (fake: { execs: FakeExec[] }) =>
  fake.execs.filter((exec) => isPiSession(exec.spec));

export const piSession = (fake: { execs: FakeExec[] }) => piSessions(fake).at(-1);

export const piArgsOf = (exec: FakeExec | undefined) => {
  const command = exec?.spec.command ?? [];

  return command.slice(command.indexOf("pi") + 1);
};

export const renderDirOf = (harness: HarnessPaths) =>
  stateLayout(harness.stateDir).repo(sha256Hex(harness.repoRoot)).render;

export const sweepNow = async (deps: CliDeps) => {
  await rm(stateLayout(pathsOf(deps).stateDir).gcRecord, { force: true });

  const lines = await sweepOrphans(deps, deps.backend());

  deps.stdout.write(lines.map((line) => `${line}\n`).join(""));

  return 0;
};

export const holdLaunch = async (harness: HarnessPaths) => {
  await registerLaunch(harness.stateDir, {
    launchId: newLaunchId(),
    ...(await processMark()),
    repoHash: sha256Hex(harness.repoRoot),
    startedAt: 1,
  });
};

export const noHostPiLine = (agentDir: string) =>
  `no managed pi in ${agentDir} (a pi installed with npm or found on PATH is not used): the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable; install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run the launcher's install.sh again`;

export interface DoctorCheck {
  section: string;
  status: string;
  name: string;
  detail: string;
  reasons: string[];
  hint?: string;
}

export interface DoctorReport {
  sections: string[];
  checks: DoctorCheck[];
  notices: string[];
  result?: string;
}

const CHECK_LINE = /^ {2}(ok|warn|fail|skip) +(\S+(?: \S+)*?)(?: {2,}(.*))?$/;

const SUB_LINE = /^ {8}(\S.*)$/;

const readLine = (report: DoctorReport, line: string) => {
  const section = report.sections.at(-1) ?? "";
  const check = CHECK_LINE.exec(line);
  const sub = SUB_LINE.exec(line)?.[1];
  const last = report.checks.at(-1);

  if (line.startsWith("result: ")) {
    report.result = line.slice("result: ".length);
  } else if (/^\S/.test(line)) {
    report.sections.push(line);
  } else if (section === "notices" && /^ {2}\S/.test(line)) {
    report.notices.push(line.slice(2));
  } else if (sub !== undefined && last !== undefined) {
    if (sub.startsWith("hint: ")) {
      last.hint = [last.hint, sub.slice("hint: ".length)].filter((text) => text !== undefined).join("\n");
    } else {
      last.reasons.push(sub);
    }
  } else if (check !== null) {
    report.checks.push({
      section,
      status: check[1] ?? "",
      name: check[2] ?? "",
      detail: check[3] ?? "",
      reasons: [],
    });
  } else if (line !== "") {
    throw new Error(`not a doctor report line: ${JSON.stringify(line)}`);
  }
};

export const doctorReport = (stdout: string): DoctorReport => {
  const report: DoctorReport = { sections: [], checks: [], notices: [] };

  stdout.split("\n").forEach((line) => {
    readLine(report, line);
  });

  return report;
};

export const doctorCheck = (stdout: string, name: string) =>
  doctorReport(stdout).checks.find((check) => check.name === name);

interface ManagedPiOptions {
  marker?: unknown;
  release?: string;
  nodeModules?: string;
  wrapper?: (packageDir: string) => string;
}

const MANAGED_MARKER = {
  kind: "pi-managed-install",
  schemaVersion: 1,
  layout: "releases-v1",
  entrypoint: { type: "symlink", path: "/unused/.local/bin/pi" },
};

export const writeManagedPi = async (agentDir: string, version: string, options: ManagedPiOptions = {}) => {
  const install = join(agentDir, "install");
  const releaseDir = join(install, "releases", version);
  const packageDir = join(releaseDir, "node_modules", "@earendil-works", "pi-coding-agent");
  const wrapper = join(agentDir, "bin", "pi");

  if (options.nodeModules === undefined) {
    await mkdir(packageDir, { recursive: true });

    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/cli.js" } }),
    );
  } else {
    await mkdir(releaseDir, { recursive: true });

    await symlink(options.nodeModules, join(releaseDir, "node_modules"));
  }

  await writeFile(join(install, "managed-install.json"), JSON.stringify(options.marker ?? MANAGED_MARKER));

  await writeFile(join(install, "current-version"), `${options.release ?? version}\n`);

  await writeScript(wrapper, options.wrapper?.(packageDir) ?? 'echo managed pi "$@"');

  return { wrapper, packageDir, entry: join(packageDir, "dist", "cli.js") };
};

const writeScript = async (path: string, body: string) => {
  await mkdir(join(path, ".."), { recursive: true });

  await writeFile(path, `#!/bin/sh\n${body}\n`);

  await chmod(path, 0o755);
};

export const writePathPi = async (dir: string, version?: string) => {
  const packageDir = join(dir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  const pi = join(dir, "bin", "pi");

  if (version === undefined) {
    await writeScript(pi, "echo path pi");

    return { bin: join(dir, "bin"), pi, packageDir };
  }

  await writeScript(join(packageDir, "dist", "cli.js"), "echo path pi");

  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
  );

  await mkdir(join(dir, "bin"), { recursive: true });

  await symlink(join(packageDir, "dist", "cli.js"), pi);

  return { bin: join(dir, "bin"), pi, packageDir };
};

export interface YamlMount {
  location: string;
  writable?: boolean;
  mountPoint?: string;
}

const mountLines = (mount: YamlMount, indent: string) =>
  [
    `${indent}- location: "${mount.location}"`,
    ...(mount.writable === undefined ? [] : [`${indent}  writable: ${mount.writable}`]),
    ...(mount.mountPoint === undefined ? [] : [`${indent}  mountPoint: ${mount.mountPoint}`]),
  ].join("\n");

const mountsYaml = (mounts: YamlMount[], indent: string) =>
  mounts.length === 0
    ? "mounts: []\n"
    : `mounts:\n${mounts.map((mount) => mountLines(mount, indent)).join("\n")}\n`;

const limaYamlPath = (home: string) => join(home, ".colima", "_lima", "colima-pi-sandbox", "lima.yaml");

const colimaYamlPath = (home: string) => join(home, ".colima", "pi-sandbox", "colima.yaml");

export const writeLimaMounts = async (home: string, mounts: YamlMount[]) => {
  const file = limaYamlPath(home);

  await mkdir(join(file, ".."), { recursive: true });

  await writeFile(file, `vmType: vz\n${mountsYaml(mounts, "")}ssh:\n  localPort: 0\n`);
};

export const writeColimaMounts = async (home: string, mounts: YamlMount[]) => {
  const file = colimaYamlPath(home);

  await mkdir(join(file, ".."), { recursive: true });

  await writeFile(
    file,
    `cpu: 8\n# Colima default behaviour: $HOME is mounted as writable.\n${mountsYaml(mounts, "  ")}mountType: virtiofs\n`,
  );
};

export const createHarness = async (options: HarnessOptions = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-cli-")));

  roots.push(root);

  const repoRoot = join(root, "repo");
  const cwd = join(repoRoot, "src");
  const stateDir = join(root, "state");
  const userConfigFile = join(root, "config", "config.json");

  const hostAgentDir = join(root, "home", ".pi", "agent");
  const trustPem = join(stateDir, "ca", "trust.pem");

  mkdirSync(join(repoRoot, ".git", "hooks"), { recursive: true });

  mkdirSync(join(stateDir, "ca"), { recursive: true });

  writeFileSync(trustPem, "trust bundle\n");

  writeFileSync(join(stateDir, "ca", "extra.pem"), "");
  mkdirSync(cwd, { recursive: true });

  if (options.hostPi !== false) {
    await writeManagedPi(hostAgentDir, await testedPiVersion());
  }

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

    if (isTlsProbeScript(call)) {
      return { stdout: `${NOT_INSPECTED}\n` };
    }

    if (call.interactive) {
      return { code: 0 };
    }

    return call.file === "git" ? gitAnswer(repoRoot, call.args) : undefined;
  });
  const terminalOut = new PassThrough();
  const stoppedProxies: string[] = [];
  const proxyInputs: RepoProxyInput[] = [];
  const proxyState = { stopped: false };
  const deps: CliDeps = {
    runner: fake.runner,
    env: {
      PI_SANDBOX_STATE_DIR: stateDir,
      PI_SANDBOX_USER_CONFIG: userConfigFile,
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
    machine: options.machine ?? { cpus: 8, memoryGiB: 32 },
    backend: options.backend ?? unreachableBackend,
    proxy: {
      ensure: async (request) => {
        proxyInputs.push(request.input);

        proxyState.stopped = false;

        return { proxy: RUNNING_PROXY, notices: [] };
      },
      read: async () => undefined,
      stop: async (_stateDir, repoHash) => {
        stoppedProxies.push(repoHash);

        proxyState.stopped = true;

        return false;
      },
      denials: async () => (proxyState.stopped ? [] : (options.denials ?? [])),
      trust: async () => ({
        pemPath: trustPem,
        caCertPath: trustPem,
        extraPemPath: join(stateDir, "ca", "extra.pem"),
        hash: "trust-hash",
      }),
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
    hostAgentDir,
    trustPem,
    userConfigFile,
    deps,
    calls: fake.calls,
    stoppedProxies,
    proxyInputs,
    stdout: stdout.text,
    stderr: stderr.text,
    writeJson,
    cleanup: () => removeRoot(root),
  };
};
