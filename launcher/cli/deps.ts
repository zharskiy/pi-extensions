import { Writable } from "node:stream";
import { type Backend, engineUnreachable } from "../backend/index.ts";
import type { ExtraCa } from "../config/index.ts";
import type { HostTerminal, SignalSource } from "../container/index.ts";
import type { DenialRecord, ProxyInput, ProxyRecord, ProxyStart, TrustBundle } from "../proxy/index.ts";
import { type CommandRunner, hostAgentDir, launcherPaths } from "../shared/index.ts";
import { colourOf, type TtyStreams } from "./prompt/terminal.ts";

interface ProxyRequest {
  stateDir: string;
  input: ProxyInput;
  env: NodeJS.ProcessEnv;
  othersLive: () => Promise<boolean>;
}

interface ProxyControl {
  ensure(request: ProxyRequest): Promise<ProxyStart>;
  read(stateDir: string): Promise<ProxyRecord | undefined>;
  stop(stateDir: string): Promise<boolean>;
  denials(stateDir: string, since: number): Promise<DenialRecord[]>;
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
  openTty?: () => TtyStreams | undefined;
  platform: NodeJS.Platform;
  machine: { cpus: number; memoryGiB: number };
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
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
    [...new Set(notices)].map((notice) => `pinata: ${notice}`),
  );
};

export const isTerminal = (stream: object) => "isTTY" in stream && stream.isTTY === true;

export const colorOf = (deps: Pick<CliDeps, "stdout" | "env">) => colourOf(deps.env, deps.stdout);

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
