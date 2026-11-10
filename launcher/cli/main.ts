import { cpus, homedir, totalmem } from "node:os";
import { createColimaBackend } from "../backend/index.ts";
import { findOnPath, locateBundledPi } from "../hostpi/index.ts";
import {
  ensureRepoProxy,
  ensureTrustBundle,
  readDenials,
  readRepoProxy,
  stopRepoProxy,
} from "../proxy/index.ts";
import { createProcessRunner, realOrResolved, withResolvedCommand } from "../shared/index.ts";
import { findGitRoot } from "../workspace/index.ts";
import { type CliDeps, onClosedOutput, pathsOf } from "./deps.ts";
import { renderFailure, run } from "./run.ts";
import { hostTerminal } from "./terminal.ts";

const GIB = 1024 ** 3;

const hostGit = (env: NodeJS.ProcessEnv, cwd: string) => async () => {
  const folder = await realOrResolved(cwd);
  const root = await findGitRoot(folder);

  return findOnPath(env, "git", root === undefined ? [folder] : [folder, root]);
};

const realDeps = (): CliDeps => {
  const env = process.env;
  const cwd = process.cwd();
  const runner = withResolvedCommand(createProcessRunner(), "git", hostGit(env, cwd));
  const home = homedir();
  const platform = process.platform;
  const { stateDir } = pathsOf({ env, home, platform });

  return {
    runner,
    env,
    home,
    cwd,
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
