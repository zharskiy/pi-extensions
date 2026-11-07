import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { Writable } from "node:stream";
import type { Backend, TerminalSize } from "../backend/index.ts";
import type { Workspace } from "../workspace/index.ts";

export interface HostTerminal {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  columns: number;
  rows: number;
  onResize(listener: (size: TerminalSize) => void): () => void;
}

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface RunPiInput {
  backend: Backend;
  containerId: string;
  piArgs: string[];
  env?: Record<string, string>;
  launchId?: string;
  workspace: Workspace;
  terminal: HostTerminal;
  signals?: SignalSource;
  graceMs?: number;
}

const SIGNAL_EXIT_BASE = 128;

const GRACE_MS = 5000;

const TTY_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];

const PIPE_SIGNALS: NodeJS.Signals[] = ["SIGINT", ...TTY_SIGNALS];

const LAUNCH_ID_BYTES = 8;

const pidFileOf = (launchId: string) => `/tmp/pi-sandbox-${launchId}.pid`;

const launchEnv = (launchId: string | undefined): Record<string, string> =>
  launchId === undefined ? {} : { PI_SANDBOX_LAUNCH_ID: launchId };

const discard = () =>
  new Writable({
    write: (_chunk, _encoding, done) => done(),
  });

const withRawMode = async <T>(terminal: HostTerminal, action: () => Promise<T>) => {
  const raw = terminal.stdin.isTTY === true && terminal.stdin.setRawMode !== undefined;

  if (raw) {
    terminal.stdin.setRawMode?.(true);
  }

  try {
    return await action();
  } finally {
    if (raw) {
      terminal.stdin.setRawMode?.(false);
    }
  }
};

export const listenFor = (source: SignalSource, names: NodeJS.Signals[]) => {
  const stops: Array<() => void> = [];
  const received = new Promise<NodeJS.Signals>((resolve) => {
    names.forEach((name) => {
      const listener = () => resolve(name);

      source.on(name, listener);

      stops.push(() => source.off(name, listener));
    });
  });

  const stop = () =>
    stops.forEach((unsubscribe) => {
      unsubscribe();
    });

  return { received, stop };
};

const endsWithin = (running: Promise<unknown>, ms: number) => {
  const timer: { handle?: NodeJS.Timeout } = {};
  const ended = running.then(
    () => true,
    () => true,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer.handle = setTimeout(() => resolve(false), ms);
  });

  return Promise.race([ended, timeout]).finally(() => clearTimeout(timer.handle));
};

const quietExec = (input: RunPiInput, script: string) =>
  input.backend
    .exec(
      { containerId: input.containerId, command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdout: discard(), stderr: discard(), tty: false },
    )
    .catch(() => undefined);

const settleSignal = async (
  input: RunPiInput,
  running: Promise<number>,
  signal: NodeJS.Signals,
  pidFile: string,
) => {
  await quietExec(input, `kill -TERM "$(cat ${pidFile})"`);

  const ended = await endsWithin(running, input.graceMs ?? GRACE_MS);

  if (!ended) {
    await quietExec(input, `kill -KILL "$(cat ${pidFile})"`);
  }

  return SIGNAL_EXIT_BASE + constants.signals[signal];
};

const execPi = (input: RunPiInput, tty: boolean, pidFile: string) =>
  input.backend.exec(
    {
      containerId: input.containerId,
      command: ["sh", "-c", `echo $$ > ${pidFile}; exec "$@"`, "sh", "pi", ...input.piArgs],
      env: { ...input.env, ...launchEnv(input.launchId) },
      workdir: input.workspace.cwd,
    },
    {
      stdin: input.terminal.stdin,
      stdout: input.terminal.stdout,
      stderr: input.terminal.stderr,
      tty,
      size: { columns: input.terminal.columns, rows: input.terminal.rows },
      onResize: input.terminal.onResize,
    },
  );

export const runPi = (input: RunPiInput) =>
  withRawMode(input.terminal, async () => {
    const tty = input.terminal.stdin.isTTY === true;
    const watch = listenFor(input.signals ?? process, tty ? TTY_SIGNALS : PIPE_SIGNALS);
    const pidFile = pidFileOf(randomBytes(LAUNCH_ID_BYTES).toString("hex"));

    try {
      const running = execPi(input, tty, pidFile);
      const outcome = await Promise.race([
        running.then((code) => ({ code })),
        watch.received.then((signal) => ({ signal })),
      ]);

      return "signal" in outcome ? await settleSignal(input, running, outcome.signal, pidFile) : outcome.code;
    } finally {
      watch.stop();

      await quietExec(input, `rm -f ${pidFile}`);
    }
  });
