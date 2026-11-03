import type { ExecIo, ExecSpec, TerminalSize } from "../types.ts";
import { envList } from "./container-body.ts";
import { type EngineClient, type Hijacked, segment } from "./engine-client.ts";

interface ExecInspect {
  Running: boolean;
  ExitCode: number | null;
}

const FRAME_HEADER = 8;

const STDERR_STREAM = 2;

const EXIT_POLL_MS = 50;

const EXIT_POLL_ATTEMPTS = 100;

const consoleSizeOf = (io: ExecIo) =>
  io.tty && io.size !== undefined ? [io.size.rows, io.size.columns] : undefined;

const execBody = (spec: ExecSpec, io: ExecIo) => ({
  AttachStdin: io.stdin !== undefined,
  AttachStdout: true,
  AttachStderr: true,
  Tty: io.tty,
  Env: envList(spec.env),
  WorkingDir: spec.workdir,
  Cmd: spec.command,
  ConsoleSize: consoleSizeOf(io),
});

const demultiplexer = (io: ExecIo) => {
  const state = { pending: Buffer.alloc(0) };

  const drain = (): void => {
    if (state.pending.length < FRAME_HEADER) {
      return;
    }

    const end = FRAME_HEADER + state.pending.readUInt32BE(4);

    if (state.pending.length < end) {
      return;
    }

    const target = state.pending[0] === STDERR_STREAM ? io.stderr : io.stdout;

    target.write(state.pending.subarray(FRAME_HEADER, end));

    state.pending = state.pending.subarray(end);

    drain();
  };

  return (chunk: Buffer) => {
    state.pending = Buffer.concat([state.pending, chunk]);

    drain();
  };
};

const attachInput = (stdin: NodeJS.ReadableStream | undefined, socket: Hijacked["socket"]) => {
  if (stdin === undefined) {
    socket.end();

    return () => undefined;
  }

  const forward = (chunk: Buffer | string) => socket.write(chunk);

  const closeInput = () => socket.end();

  stdin.on("data", forward);

  stdin.once("end", closeInput);

  return () => {
    stdin.removeListener("data", forward);

    stdin.removeListener("end", closeInput);

    stdin.pause();
  };
};

const pump = (hijacked: Hijacked, io: ExecIo) =>
  new Promise<void>((resolve, reject) => {
    const { socket, head } = hijacked;
    const deliver = io.tty ? (chunk: Buffer) => io.stdout.write(chunk) : demultiplexer(io);

    if (head.length > 0) {
      deliver(head);
    }

    socket.on("data", deliver);

    const detach = attachInput(io.stdin, socket);

    socket.once("close", () => {
      detach();

      resolve();
    });

    socket.once("error", (error) => {
      detach();

      reject(error);
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const exitCodeOf = async (
  client: EngineClient,
  execId: string,
  attempts = EXIT_POLL_ATTEMPTS,
): Promise<number> => {
  const inspect = await client.json<ExecInspect>({ method: "GET", path: `/exec/${segment(execId)}/json` });

  if (!inspect.Running || attempts <= 1) {
    return inspect.ExitCode ?? 1;
  }

  await sleep(EXIT_POLL_MS);

  return exitCodeOf(client, execId, attempts - 1);
};

export const runExec = async (client: EngineClient, spec: ExecSpec, io: ExecIo) => {
  const created = await client.json<{ Id: string }>({
    method: "POST",
    path: `/containers/${segment(spec.containerId)}/exec`,
    json: execBody(spec, io),
  });

  const resize = (size: TerminalSize) => {
    void client
      .call({
        method: "POST",
        path: `/exec/${segment(created.Id)}/resize`,
        query: { h: size.rows, w: size.columns },
      })
      .catch(() => undefined);
  };

  const hijacked = await client.upgrade({
    method: "POST",
    path: `/exec/${segment(created.Id)}/start`,
    json: { Detach: false, Tty: io.tty, ConsoleSize: consoleSizeOf(io) },
  });

  if (io.tty && io.size !== undefined) {
    resize(io.size);
  }

  const stopResizing = io.tty && io.onResize !== undefined ? io.onResize(resize) : () => undefined;

  try {
    await pump(hijacked, io);
  } finally {
    stopResizing();
  }

  return exitCodeOf(client, created.Id);
};
