import { type Backend, engineUnreachable } from "../backend/index.ts";
import type { ExtraCa, SandboxConfig } from "../config/index.ts";
import type { HostTerminal, SignalSource } from "../container/index.ts";
import type { BundledPi } from "../hostpi/index.ts";
import type { DenialRecord, RepoProxy, RepoProxyInput, RepoProxyStart, TrustBundle } from "../proxy/index.ts";
import { type CommandRunner, hostAgentDir, LauncherError, launcherPaths } from "../shared/index.ts";

interface ProxyRequest {
  stateDir: string;
  input: RepoProxyInput;
  env: NodeJS.ProcessEnv;
  othersLive: () => Promise<boolean>;
}

interface ProxyControl {
  ensure(request: ProxyRequest): Promise<RepoProxyStart>;
  read(stateDir: string, repoHash: string): Promise<RepoProxy | undefined>;
  stop(stateDir: string, repoHash: string): Promise<boolean>;
  denials(stateDir: string, repoHash: string, since: number): Promise<DenialRecord[]>;
  trust(stateDir: string, sources: ExtraCa[]): Promise<TrustBundle>;
}

export interface CliDeps {
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  terminal: HostTerminal;
  signals?: SignalSource;
  platform: NodeJS.Platform;
  uid: number;
  machine: { cpus: number; memoryGiB: number };
  backend(): Backend;
  proxy: ProxyControl;
  bundledPi(): Promise<BundledPi | undefined>;
  resolveHost(host: string): Promise<string[]>;
  dnsWaitMs?: number;
  confirm(question: string): Promise<boolean>;
  now(): number;
}

export const writeLine = (stream: NodeJS.WritableStream, line: string) => {
  stream.write(`${line}\n`);
};

export const writeLines = (stream: NodeJS.WritableStream, lines: string[]) => {
  stream.write(lines.map((line) => `${line}\n`).join(""));
};

export const writeNotices = (deps: CliDeps, notices: string[]) => {
  writeLines(
    deps.stderr,
    [...new Set(notices)].map((notice) => `pi-sandbox: ${notice}`),
  );
};

const fallbackHint = (hint: string | undefined) => {
  const hostPi = "or run pi --no-sandbox to use host pi";

  return hint === undefined ? hostPi : `${hint}; ${hostPi}`;
};

export const withFallbackHint = (error: unknown, fallback: SandboxConfig["fallback"]) =>
  error instanceof LauncherError && fallback === "host"
    ? new LauncherError(error.message, fallbackHint(error.hint))
    : error;

export const pathsOf = (deps: Pick<CliDeps, "env" | "home" | "platform">) =>
  launcherPaths({ env: deps.env, home: deps.home, platform: deps.platform });

export const hostAgentDirOf = (deps: CliDeps) => hostAgentDir(deps.home, deps.env);

export const reachableBackend = async (deps: CliDeps, config: SandboxConfig) => {
  const backend = deps.backend();

  if ((await backend.detect()).available) {
    return backend;
  }

  throw withFallbackHint(engineUnreachable(), config.fallback);
};
