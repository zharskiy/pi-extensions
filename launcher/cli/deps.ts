import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import type { HostTerminal, SignalSource } from "../container/index.ts";
import type { ProxyInstance } from "../proxy/index.ts";
import { type CommandRunner, launcherPaths } from "../shared/index.ts";

interface ProxyRequest {
  config: SandboxConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
}

interface ProxyControl {
  ensure(request: ProxyRequest): Promise<ProxyInstance>;
  list(stateDir: string): Promise<ProxyInstance[]>;
  stop(stateDir: string, policyHash?: string): Promise<number>;
  remove(stateDir: string, policyHash: string): Promise<boolean>;
  ensureCa(stateDir: string): Promise<{ certPemPath: string }>;
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
  gid: number;
  adapters(): Backend[];
  proxy: ProxyControl;
  now(): number;
}

export const writeLine = (stream: NodeJS.WritableStream, line: string) => {
  stream.write(`${line}\n`);
};

export const writeLines = (stream: NodeJS.WritableStream, lines: string[]) => {
  stream.write(lines.map((line) => `${line}\n`).join(""));
};

export const pathsOf = (deps: CliDeps) =>
  launcherPaths({ env: deps.env, home: deps.home, platform: deps.platform });
