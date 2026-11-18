import { once } from "node:events";
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

const ABORTED_EXIT = 1;

const consoleSizeOf = (io: ExecIo) =>
  io.tty && io.size !== undefined ? [io.size.rows, io.size.columns] : undefined;

const execBody = (spec: ExecSpec, io: ExecIo) => ({
  AttachStdin: io.stdin !== undefined,
  AttachStdout: true,
  AttachStderr: true,
  Tty: io.tty,
  Env: envList(spec.env),
  WorkingDir: spec.workdir,
  ...(spec.user === undefined ? {} : { User: spec.user }),
  Cmd: spec.command,
  ConsoleSize: consoleSizeOf(io),
});

type Sink = (target: NodeJS.WritableStream, data: Buffer) => void;

export const demultiplexer = (io: ExecIo, sink: Sink) => {
  const state = { header: Buffer.alloc(0), remaining: 0, target: io.stdout };

  const deliver = (chunk: Buffer) => {
    const cursor = { offset: 0 };

    while (cursor.offset < chunk.length) {
      const rest = chunk.subarray(cursor.offset);

      if (state.remaining > 0) {
        const size = Math.min(state.remaining, rest.length);

        state.remaining -= size;
        cursor.offset += size;

        sink(state.target, rest.subarray(0, size));

        continue;
      }

      const needed = FRAME_HEADER - state.header.length;

      state.header = Buffer.concat([state.header, rest.subarray(0, needed)]);
      cursor.offset += Math.min(needed, rest.length);

      if (state.header.length === FRAME_HEADER) {
        state.target = state.header[0] === STDERR_STREAM ? io.stderr : io.stdout;
        state.remaining = state.header.readUInt32BE(4);
        state.header = Buffer.alloc(0);
      }
    }
  };

  return deliver;
};

const attachInput = (stdin: NodeJS.ReadableStream | undefined, socket: Hijacked["socket"]) => {
  if (stdin === undefined) {
    socket.end();

    return () => undefined;
  }

  stdin.pipe(socket);

  return () => {
    stdin.unpipe(socket);

    stdin.pause();
  };
};

const isBrokenPipe = (error: NodeJS.ErrnoException) => error.code === "EPIPE";

const flushed = (output: NodeJS.WritableStream) =>
  new Promise<void>((done) => {
    output.write(Buffer.alloc(0), () => done());
  });

const pump = (hijacked: Hijacked, io: ExecIo) =>
  new Promise<void>((resolve, reject) => {
    const { socket, head } = hijacked;
    const blocked = new Set<NodeJS.WritableStream>();
    const outputs = [...new Set([io.stdout, io.stderr])];
    const state: { broken: boolean; failure?: Error } = { broken: false };

    const sink: Sink = (target, data) => {
      if (!state.broken && !target.write(data)) {
        blocked.add(target);
      }
    };

    const deliver = io.tty ? (chunk: Buffer) => sink(io.stdout, chunk) : demultiplexer(io, sink);

    const resume = () => {
      socket.resume();
    };

    const receive = (chunk: Buffer) => {
      deliver(chunk);

      if (blocked.size === 0) {
        return;
      }

      const waiting = [...blocked];

      blocked.clear();

      socket.pause();

      void Promise.all(waiting.map((target) => once(target, "drain"))).then(resume, resume);
    };

    const broken = (error: NodeJS.ErrnoException) => {
      if (!isBrokenPipe(error)) {
        state.failure ??= error;

        socket.destroy(error);

        return;
      }

      state.broken = true;

      socket.destroy();
    };

    outputs.forEach((output) => {
      output.on("error", broken);
    });

    const detachInput = attachInput(io.stdin, socket);

    const detach = () => {
      detachInput();

      outputs.forEach((output) => {
        output.off("error", broken);
      });
    };

    receive(head);

    socket.on("data", receive);

    socket.once("close", () => {
      void Promise.all(outputs.map(flushed)).then(() => {
        detach();

        if (state.failure === undefined) {
          resolve();
        } else {
          reject(state.failure);
        }
      });
    });

    socket.once("error", (error) => {
      detach();

      reject(error);
    });
  });

const abortWith = (signal: AbortSignal | undefined, abort: () => void) => {
  if (signal === undefined) {
    return () => undefined;
  }

  if (signal.aborted) {
    abort();

    return () => undefined;
  }

  signal.addEventListener("abort", abort, { once: true });

  return () => signal.removeEventListener("abort", abort);
};

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
  const stopAborting = abortWith(io.signal, () => hijacked.socket.destroy());

  try {
    await pump(hijacked, io);
  } finally {
    stopResizing();

    stopAborting();
  }

  return io.signal?.aborted === true ? ABORTED_EXIT : exitCodeOf(client, created.Id);
};
