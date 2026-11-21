import { statfs } from "node:fs/promises";
import { availableParallelism, homedir, totalmem } from "node:os";
import { createColimaBackend } from "../backend/index.ts";
import { findOnPath } from "../hostpi/index.ts";
import {
  ensureRepoProxy,
  ensureTrustBundle,
  readDenials,
  readRepoProxy,
  stopRepoProxy,
} from "../proxy/index.ts";
import { createProcessRunner, GIB, withResolvedCommand } from "../shared/index.ts";
import { startedRoots } from "../workspace/index.ts";
import { type CliDeps, onClosedOutput, pathsOf } from "./deps.ts";
import { openDevTty } from "./prompt/terminal.ts";
import { renderFailure, run } from "./run.ts";
import { hostTerminal } from "./terminal.ts";

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
    uid: process.getuid?.() ?? 0,
    machine: { cpus: availableParallelism(), memoryGiB: totalmem() / GIB },
    statfs: (path) => statfs(path),
    backend: () => createColimaBackend({ home, stateDir, runner }),
    proxy: {
      ensure: (request) => ensureRepoProxy({ ...request, runner }),
      read: readRepoProxy,
      stop: stopRepoProxy,
      denials: readDenials,
      trust: (stateDir, sources, launchId) =>
        ensureTrustBundle({ stateDir, runner, platform: process.platform, sources, launchId }),
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
