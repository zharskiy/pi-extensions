import { statfs } from "node:fs/promises";
import { availableParallelism, homedir, totalmem } from "node:os";
import { createColimaBackend } from "../backend/index.ts";
import { findOnPath } from "../hostpi/index.ts";
import { ensureProxy, ensureTrustBundle, readDenials, readProxy, stopProxy } from "../proxy/index.ts";
import { createProcessRunner, withResolvedCommand } from "../shared/index.ts";
import { startedRoots } from "../workspace/index.ts";
import { type CliDeps, onClosedOutput, pathsOf } from "./deps.ts";
import { openDevTty } from "./prompt/terminal.ts";
import { renderFailure, run } from "./run.ts";
import { hostTerminal } from "./terminal.ts";

const GIB = 1024 ** 3;

const hostGit = (env: NodeJS.ProcessEnv, cwd: string) => async () =>
  findOnPath(env, "git", await startedRoots(cwd));

const realDeps = (): CliDeps => {
  const env = process.env;
  const cwd = process.cwd();
  const runner = withResolvedCommand(createProcessRunner(), "git", hostGit(env, cwd));
  const home = homedir();
  const platform = process.platform;
  const { stateDir } = pathsOf({ env, home });

  return {
    runner,
    env,
    home,
    cwd,
    stdout: process.stdout,
    stderr: process.stderr,
    terminal: hostTerminal(),
    openTty: openDevTty,
    platform,
    machine: { cpus: availableParallelism(), memoryGiB: totalmem() / GIB },
    statfs: (path) => statfs(path),
    backend: () => createColimaBackend({ home, stateDir, runner }),
    proxy: {
      ensure: (request) => ensureProxy({ ...request, runner }),
      read: readProxy,
      stop: stopProxy,
      denials: readDenials,
      trust: (stateDir, sources) =>
        ensureTrustBundle({ stateDir, runner, platform: process.platform, sources }),
    },
    now: () => Date.now(),
  };
};

const flushed = (stream: NodeJS.WritableStream) =>
  new Promise<void>((resolve) => stream.write("", () => resolve()));

const exitWith = async (code: number) => {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);

  process.exit(code);
};

onClosedOutput([process.stdout, process.stderr], () => process.emit("SIGTERM"));

const main = async () => {
  try {
    return await run(process.argv.slice(2), realDeps());
  } catch (error) {
    return renderFailure(error, process.stderr);
  }
};

await exitWith(await main());
