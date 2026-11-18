import { constants } from "node:os";
import { Writable } from "node:stream";
import type { Backend, TerminalSize } from "../backend/index.ts";
import type { Workspace } from "../workspace/index.ts";

export interface HostTerminal {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
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
  launchId: string;
  workspace: Workspace;
  terminal: HostTerminal;
  signals?: SignalSource;
  graceMs?: number;
}

const SIGNAL_EXIT_BASE = 128;

const GRACE_MS = 5000;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const PID_FILE = "/tmp/pi-sandbox-pi.pid";

const isInteractive = (terminal: HostTerminal) =>
  terminal.stdin.isTTY === true && terminal.stdout.isTTY === true;

const discard = () =>
  new Writable({
    write: (_chunk, _encoding, done) => done(),
  });

const withRawMode = async <T>(terminal: HostTerminal, interactive: boolean, action: () => Promise<T>) => {
  const raw = interactive && terminal.stdin.setRawMode !== undefined;

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

const listenFor = (source: SignalSource, names: NodeJS.Signals[]) => {
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
  endsWithin(
    input.backend.exec(
      { containerId: input.containerId, command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdout: discard(), stderr: discard(), tty: false },
    ),
    input.graceMs ?? GRACE_MS,
  );

const settleSignal = async (input: RunPiInput, running: Promise<number>, signal: NodeJS.Signals) => {
  const grace = input.graceMs ?? GRACE_MS;
  const signalled = SIGNAL_EXIT_BASE + constants.signals[signal];
  const code = running.catch(() => signalled);

  await quietExec(input, `kill -TERM "$(cat ${PID_FILE})"`);

  if (await endsWithin(running, grace)) {
    return code;
  }

  await endsWithin(input.backend.stopContainer(input.containerId, 0), grace);

  return signalled;
};

const PI_SCRIPT = `echo $$ > ${PID_FILE}; cd "$1" 2>/dev/null || echo "pi-sandbox: $1 is not in the sandbox, pi starts in $PWD" >&2; shift; exec "$@"`;

const execPi = (input: RunPiInput, tty: boolean) =>
  input.backend.exec(
    {
      containerId: input.containerId,
      command: ["sh", "-c", PI_SCRIPT, "sh", input.workspace.cwd, "pi", ...input.piArgs],
      env: { ...input.env, PI_SANDBOX_LAUNCH_ID: input.launchId },
      workdir: input.workspace.repoRoot,
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

export const runPi = (input: RunPiInput) => {
  const interactive = isInteractive(input.terminal);

  return withRawMode(input.terminal, interactive, async () => {
    const watch = listenFor(input.signals ?? process, SIGNALS);

    try {
      const running = execPi(input, interactive);
      const outcome = await Promise.race([
        running.then((code) => ({ code })),
        watch.received.then((signal) => ({ signal })),
      ]);

      return "signal" in outcome ? await settleSignal(input, running, outcome.signal) : outcome.code;
    } finally {
      watch.stop();
    }
  });
};
