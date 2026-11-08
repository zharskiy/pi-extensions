import type { Backend } from "../backend/index.ts";
import type { ExtraCa, SandboxConfig } from "../config/index.ts";
import type { HostTerminal, SignalSource } from "../container/index.ts";
import type { BundledPi } from "../hostpi/index.ts";
import type {
  ControlMessage,
  ControlReply,
  DenialRecord,
  ProxyInstance,
  TrustBundle,
} from "../proxy/index.ts";
import { type CommandRunner, hostAgentDir, LauncherError, launcherPaths } from "../shared/index.ts";

interface ProxyRequest {
  config: SandboxConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  piCommand: string[];
  piVersion?: string;
}

interface DenialFilter {
  repoHash: string;
  since: number;
}

interface ProxyControl {
  ensure(request: ProxyRequest): Promise<ProxyInstance>;
  list(stateDir: string): Promise<ProxyInstance[]>;
  stop(stateDir: string, policyHash?: string): Promise<number>;
  remove(stateDir: string, policyHash: string): Promise<boolean>;
  control(instance: ProxyInstance, message: ControlMessage): Promise<ControlReply>;
  denials(stateDir: string, policyHash: string, filter: DenialFilter): Promise<DenialRecord[]>;
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
  backend(): Backend;
  proxy: ProxyControl;
  bundledPi(): Promise<BundledPi | undefined>;
  resolveHost(host: string): Promise<string[]>;
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

export const pathsOf = (deps: CliDeps) =>
  launcherPaths({ env: deps.env, home: deps.home, platform: deps.platform });

export const hostAgentDirOf = (deps: CliDeps) => hostAgentDir(deps.home, deps.env);

export const settleAll = async <T extends readonly unknown[] | []>(
  pending: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> => {
  const results = await Promise.allSettled<readonly unknown[]>(pending);
  const failure = results.find((result) => result.status === "rejected");

  if (failure !== undefined) {
    throw failure.reason;
  }

  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
};
