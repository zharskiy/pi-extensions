import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { constants } from "node:os";
import { LauncherError } from "./errors.ts";

interface InteractiveOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunOptions extends InteractiveOptions {
  input?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(file: string, args: string[], options?: RunOptions): Promise<RunResult>;
  spawnInteractive(file: string, args: string[], options?: InteractiveOptions): Promise<number>;
}

const SIGNAL_EXIT_BASE = 128;

const exitCode = (code: number | null, signal: NodeJS.Signals | null) => {
  if (code !== null) {
    return code;
  }

  const number = signal === null ? undefined : constants.signals[signal];

  return number === undefined ? 1 : SIGNAL_EXIT_BASE + number;
};

const launchError = (file: string, error: NodeJS.ErrnoException) =>
  error.code === "ENOENT"
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

    const code = await settle(file, child);

    return {
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  };

const spawnInteractiveWith =
  (baseEnv: NodeJS.ProcessEnv) =>
  (file: string, args: string[], options: InteractiveOptions = {}) =>
    settle(file, start(file, args, "inherit", options, baseEnv));

export const createProcessRunner = (options: ProcessRunnerOptions = {}): CommandRunner => {
  const baseEnv = options.baseEnv ?? process.env;

  return { run: runWith(baseEnv), spawnInteractive: spawnInteractiveWith(baseEnv) };
};
