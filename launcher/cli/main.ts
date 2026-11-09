import { lookup } from "node:dns/promises";
import { cpus, homedir, totalmem } from "node:os";
import { createInterface } from "node:readline/promises";
import { createColimaBackend } from "../backend/index.ts";
import type { HostTerminal } from "../container/index.ts";
import { locateBundledPi } from "../hostpi/index.ts";
import {
  ensureRepoProxy,
  ensureTrustBundle,
  readDenials,
  readRepoProxy,
  stopRepoProxy,
} from "../proxy/index.ts";
import { createProcessRunner } from "../shared/index.ts";
import { type CliDeps, pathsOf } from "./deps.ts";
import { renderFailure, run } from "./run.ts";

const DEFAULT_COLUMNS = 80;

const DEFAULT_ROWS = 24;

const GIB = 1024 ** 3;

const hostTerminal = (): HostTerminal => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  columns: process.stdout.columns ?? DEFAULT_COLUMNS,
  rows: process.stdout.rows ?? DEFAULT_ROWS,
  onResize: (listener) => {
    const notify = () =>
      listener({
        columns: process.stdout.columns ?? DEFAULT_COLUMNS,
        rows: process.stdout.rows ?? DEFAULT_ROWS,
      });

    process.stdout.on("resize", notify);

    return () => {
      process.stdout.off("resize", notify);
    };
  },
});

const resolveHost = async (host: string) =>
  (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);

const confirm = async (question: string) => {
  if (process.stdin.isTTY !== true) {
    return false;
  }

  const prompt = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
};

const realDeps = (): CliDeps => {
  const runner = createProcessRunner();
  const home = homedir();
  const env = process.env;
  const platform = process.platform;
  const { stateDir } = pathsOf({ env, home, platform });

  return {
    runner,
    env,
    home,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    terminal: hostTerminal(),
    platform,
    uid: process.getuid?.() ?? 0,
    machine: { cpus: cpus().length, memoryGiB: totalmem() / GIB },
    backend: () => createColimaBackend({ home, stateDir, runner }),
    proxy: {
      ensure: (request) => ensureRepoProxy({ ...request, runner }),
      read: readRepoProxy,
      stop: stopRepoProxy,
      denials: readDenials,
      trust: (stateDir, sources) =>
        ensureTrustBundle({ stateDir, runner, platform: process.platform, sources }),
    },
    bundledPi: locateBundledPi,
    resolveHost,
    confirm,
    now: () => Date.now(),
  };
};

const flushed = (stream: NodeJS.WritableStream) =>
  new Promise<void>((resolve) => stream.write("", () => resolve()));

const exitWith = async (code: number) => {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);

  process.exit(code);
};

const main = async () => {
  try {
    return await run(process.argv.slice(2), realDeps());
  } catch (error) {
    return renderFailure(error, process.stderr);
  }
};

await exitWith(await main());
