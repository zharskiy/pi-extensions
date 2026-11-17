import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { constants } from "node:os";
import { isMissing, LauncherError } from "./errors.ts";
import { withTimeout } from "./settle.ts";

interface InteractiveOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunOptions extends InteractiveOptions {
  input?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: true;
}

export interface CommandRunner {
  run(file: string, args: string[], options?: RunOptions): Promise<RunResult>;
  spawnInteractive(file: string, args: string[], options?: InteractiveOptions): Promise<number>;
}

const SIGNAL_EXIT_BASE = 128;

const TIMEOUT_EXIT_CODE = 124;

export const signalExit = (signal: NodeJS.Signals) => SIGNAL_EXIT_BASE + constants.signals[signal];

const exitCode = (code: number | null, signal: NodeJS.Signals | null) => {
  if (code !== null) {
    return code;
  }

  return signal === null || constants.signals[signal] === undefined ? 1 : signalExit(signal);
};

const launchError = (file: string, error: NodeJS.ErrnoException) =>
  isMissing(error)
    ? new LauncherError(`${file}: command not found`, `install ${file} or add it to PATH`)
    : new LauncherError(`${file}: ${error.message}`);

export interface ProcessRunnerOptions {
  baseEnv?: Record<string, string>;
}

const start = (
  file: string,
  args: string[],
  stdio: StdioOptions,
  options: InteractiveOptions,
  baseEnv: NodeJS.ProcessEnv,
) =>
  spawn(file, args, {
    cwd: options.cwd,
    env: options.env === undefined ? baseEnv : { ...baseEnv, ...options.env },
    stdio,
  });

const settle = (file: string, child: ChildProcess) =>
  new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(launchError(file, error)));
    child.once("close", (code, signal) => resolve(exitCode(code, signal)));
  });

const EXPIRED = Symbol("expired");

const settleWithin = async (file: string, child: ChildProcess, timeoutMs: number | undefined) => {
  const settled = settle(file, child);
  const outcome = timeoutMs === undefined ? await settled : await withTimeout(settled, timeoutMs, EXPIRED);

  if (outcome === EXPIRED) {
    child.kill("SIGKILL");

    child.stdout?.destroy();

    child.stderr?.destroy();
  }

  return outcome;
};

const runWith =
  (baseEnv: NodeJS.ProcessEnv) =>
  async (file: string, args: string[], options: RunOptions = {}): Promise<RunResult> => {
    const stdin = options.input === undefined ? "ignore" : "pipe";
    const child = start(file, args, [stdin, "pipe", "pipe"], options, baseEnv);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);

    const outcome = await settleWithin(file, child, options.timeoutMs);
    const output = {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };

    return outcome === EXPIRED
      ? { code: TIMEOUT_EXIT_CODE, timedOut: true, ...output }
      : { code: outcome, ...output };
  };

const spawnInteractiveWith =
  (baseEnv: NodeJS.ProcessEnv) =>
  (file: string, args: string[], options: InteractiveOptions = {}) =>
    settle(file, start(file, args, "inherit", options, baseEnv));

export const createProcessRunner = (options: ProcessRunnerOptions = {}): CommandRunner => {
  const baseEnv = options.baseEnv ?? process.env;

  return { run: runWith(baseEnv), spawnInteractive: spawnInteractiveWith(baseEnv) };
};

export const withResolvedCommand = (
  runner: CommandRunner,
  name: string,
  resolve: () => Promise<string | undefined>,
): CommandRunner => {
  const found: { pending?: Promise<string | undefined> } = {};
  const fileOf = async (file: string) => {
    if (file !== name) {
      return file;
    }

    found.pending ??= resolve();

    const path = await found.pending;

    if (path === undefined) {
      throw new LauncherError(`${name}: command not found`, `install ${name} or add it to PATH`);
    }

    return path;
  };

  return {
    run: async (file, args, options) => runner.run(await fileOf(file), args, options),
    spawnInteractive: async (file, args, options) =>
      runner.spawnInteractive(await fileOf(file), args, options),
  };
};
