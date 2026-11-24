import { statfs } from "node:fs/promises";
import { availableParallelism, homedir, totalmem } from "node:os";
import { basename, dirname } from "node:path";
import { createColimaBackend } from "../backend/index.ts";
import { ensureProxy, ensureTrustBundle, readDenials, readProxy, stopProxy } from "../proxy/index.ts";
import { createProcessRunner, launcherRoot } from "../shared/index.ts";
import { type CliDeps, onClosedOutput, pathsOf } from "./deps.ts";
import { runPinata } from "./pinata/run.ts";
import { openDevTty } from "./prompt/terminal.ts";
import { renderFailure, run } from "./run.ts";
import { hostTerminal } from "./terminal.ts";

const GIB = 1024 ** 3;

const realDeps = (): CliDeps => {
  const env = process.env;
  const cwd = process.cwd();
  const runner = createProcessRunner();
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

const name = basename(process.argv[1] ?? "").startsWith("pinata") ? "pinata" : "pi-sandbox";

const main = async () => {
  const args = process.argv.slice(2);

  try {
    return name === "pinata"
      ? await runPinata(args, realDeps(), dirname(launcherRoot()))
      : await run(args, realDeps());
  } catch (error) {
    return renderFailure(error, process.stderr, name);
  }
};

await exitWith(await main());
