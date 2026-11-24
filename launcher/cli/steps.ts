import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { type CommandRunner, LauncherError, type RunOptions, type RunResult } from "../shared/index.ts";
import { type CliDeps, isTerminal, writeLine } from "./deps.ts";
import { asciiOf, elapsedOf, painterOf, truncate, withoutControls } from "./prompt/style.ts";
import { HEARTBEAT_MS } from "./prompt/task.ts";
import { colourOf, DEFAULT_COLUMNS, realTimers, unicodeOf } from "./prompt/terminal.ts";
import type { Timers } from "./prompt/types.ts";
import { tildeForm } from "./setup/folders.ts";

const TAIL_LINES = 20;

const CLEAR_LINE = "\r\x1b[2K";

export interface StepText<T> {
  pending: string;
  done?: string | ((value: T) => string | undefined);
  failed?: string;
}

export class ChildFailure extends LauncherError {
  readonly output: string;

  constructor(command: string[], code: number, output: string) {
    super(`${command.join(" ")} exited with code ${code}`);
    this.output = output;
  }
}

export const tilde = (deps: Pick<CliDeps, "home">, path: string) => tildeForm(path, deps.home);

const tailOf = (output: string) =>
  stripVTControlCharacters(output)
    .split(/\r?\n|\r/)
    .map((line) => withoutControls(line).trimEnd())
    .filter((line) => line !== "")
    .slice(-TAIL_LINES);

const outputOf = (result: RunResult) => [result.stdout, result.stderr].join("\n");

export const runQuietly = async (
  deps: Pick<CliDeps, "runner" | "home">,
  command: string[],
  options: RunOptions = {},
) => {
  const [file = "", ...args] = command;
  const result = await deps.runner.run(file, args, { cwd: deps.home, ...options });

  if (result.code !== 0) {
    throw new ChildFailure(command, result.code, outputOf(result));
  }

  return result;
};

export const quietDeps = (deps: CliDeps) => {
  const chunks: string[] = [];

  const kept = async (pending: Promise<RunResult>) => {
    const result = await pending;

    chunks.push(outputOf(result));

    return result;
  };

  const runner: CommandRunner = {
    run: (file, args, options) => kept(deps.runner.run(file, args, options)),
    spawnInteractive: async (file, args, options) => (await kept(deps.runner.run(file, args, options))).code,
  };

  const stderr = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      chunks.push(chunk.toString());

      done();
    },
  });

  return { deps: { ...deps, runner, stderr }, output: () => chunks.join("\n") };
};

export const glyphsShown = (deps: Pick<CliDeps, "stdout" | "env">) =>
  isTerminal(deps.stdout) && unicodeOf(deps.env);

export const stepsOf = (deps: Pick<CliDeps, "stdout" | "stderr" | "env">, timers: Timers = realTimers) => {
  const live = isTerminal(deps.stdout);
  const paint = painterOf(colourOf(deps.env, deps.stdout));
  const shown = (text: string) => (glyphsShown(deps) ? text : asciiOf(text));
  const state = { printed: false, changed: false, pending: false };
  const columns = () => ("columns" in deps.stdout && Number(deps.stdout.columns)) || DEFAULT_COLUMNS;

  const clearPending = () => {
    if (state.pending) {
      deps.stdout.write(CLEAR_LINE);

      state.pending = false;
    }
  };

  const print = (stream: NodeJS.WritableStream, line: string) => {
    clearPending();

    writeLine(stream, shown(line));

    state.printed = true;
  };

  const drawPending = (text: string) => {
    deps.stdout.write(
      `${CLEAR_LINE}${truncate(shown(`${paint("dim", "…")} ${text}`), columns() - 1, shown("…"))}`,
    );

    state.pending = true;
  };

  const done = (text: string) => {
    print(deps.stdout, `${paint("green", "✔")} ${text}`);

    state.changed = true;
  };

  const failed = (text: string, output?: string) => {
    print(deps.stderr, `${paint("red", "✖")} ${text}`);

    tailOf(output ?? "").forEach((line) => {
      writeLine(deps.stderr, `  ${paint("dim", line)}`);
    });
  };

  const task = async <T>(text: StepText<T>, action: (update: (pending: string) => void) => Promise<T>) => {
    const started = timers.now();
    const current = { text: text.pending };
    const redraw = () => drawPending(`${current.text} (${elapsedOf(timers.now() - started)})`);

    const update = (pending: string) => {
      current.text = pending;

      if (live) {
        drawPending(pending);
      }
    };

    if (live) {
      drawPending(text.pending);
    }

    const stop = live ? timers.every(HEARTBEAT_MS, redraw) : () => undefined;

    try {
      const value = await action(update);
      const line = typeof text.done === "function" ? text.done(value) : text.done;

      stop();

      clearPending();

      if (line !== undefined) {
        done(line);
      }

      return value;
    } catch (error) {
      stop();

      clearPending();

      if (text.failed !== undefined) {
        failed(text.failed, error instanceof ChildFailure ? error.output : undefined);
      }

      throw error;
    }
  };

  const close = (outcome: string, rows: Array<[string, string]> = []) => {
    const width = Math.max(0, ...rows.map(([label]) => label.length)) + 1;

    if (state.printed) {
      writeLine(deps.stdout, "");
    }

    print(deps.stdout, outcome);

    rows.forEach(([label, value]) => {
      print(deps.stdout, `  ${(label === "" ? "" : `${label}:`).padEnd(width)}  ${value}`);
    });
  };

  return {
    done,
    failed,
    task,
    close,
    warn: (text: string) => print(deps.stdout, `${paint("yellow", "▲")} ${text}`),
    note: (text: string) => print(deps.stdout, text),
    changed: () => state.changed,
  };
};

export type Steps = ReturnType<typeof stepsOf>;
