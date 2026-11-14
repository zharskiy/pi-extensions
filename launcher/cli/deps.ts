import { Writable } from "node:stream";
import { type Backend, engineUnreachable } from "../backend/index.ts";
import type { ExtraCa } from "../config/index.ts";
import type { HostTerminal, SignalSource } from "../container/index.ts";
import type { DenialRecord, RepoProxy, RepoProxyInput, RepoProxyStart, TrustBundle } from "../proxy/index.ts";
import { type CommandRunner, hostAgentDir, launcherPaths } from "../shared/index.ts";

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

export const isTerminal = (stream: object) => "isTTY" in stream && stream.isTTY === true;

export const colorOf = (deps: Pick<CliDeps, "stdout" | "env">) =>
  isTerminal(deps.stdout) && (deps.env.NO_COLOR ?? "") === "" && deps.env.TERM !== "dumb";

export const lineSink = (onLine: (line: string) => void) =>
  new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      chunk
        .toString()
        .split("\n")
        .filter((line) => line !== "")
        .forEach(onLine);

      done();
    },
  });

const CLOSED_OUTPUT = new Set(["EPIPE", "EIO", "ERR_STREAM_DESTROYED"]);

export const onClosedOutput = (streams: NodeJS.WritableStream[], closed: () => void) => {
  const state = { told: false };

  streams.forEach((stream) => {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (!CLOSED_OUTPUT.has(error.code ?? "")) {
        throw error;
      }

      if (!state.told) {
        state.told = true;

        closed();
      }
    });
  });
};

export const pathsOf = (deps: Pick<CliDeps, "env" | "home">) =>
  launcherPaths({ env: deps.env, home: deps.home });

export const hostAgentDirOf = (deps: CliDeps) => hostAgentDir(deps.home, deps.env);

export const reachableBackend = async (deps: CliDeps) => {
  const backend = deps.backend();
  const detection = await backend.detect();

  if (detection.available) {
    return backend;
  }

  throw engineUnreachable(detection);
};
