import { homedir } from "node:os";
import { createDefaultAdapters } from "../backend/index.ts";
import type { HostTerminal } from "../container/index.ts";
import {
  ensureLauncherCa,
  ensureProxyRunning,
  readProxyInstances,
  removeProxyInstance,
  stopProxy,
} from "../proxy/index.ts";
import { createProcessRunner } from "../shared/index.ts";
import type { CliDeps } from "./deps.ts";
import { renderFailure, run } from "./run.ts";

const DEFAULT_COLUMNS = 80;

const DEFAULT_ROWS = 24;

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

const realDeps = (): CliDeps => {
  const runner = createProcessRunner();
  const home = homedir();

  return {
    runner,
    env: process.env,
    home,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    terminal: hostTerminal(),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    adapters: () => createDefaultAdapters({ runner, env: process.env, home }),
    proxy: {
      ensure: (request) => ensureProxyRunning({ ...request, runner }),
      list: readProxyInstances,
      stop: stopProxy,
      remove: removeProxyInstance,
      ensureCa: (stateDir) => ensureLauncherCa(stateDir, runner),
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

const main = async () => {
  try {
    return await run(process.argv.slice(2), realDeps());
  } catch (error) {
    return renderFailure(error, process.stderr);
  }
};

await exitWith(await main());
