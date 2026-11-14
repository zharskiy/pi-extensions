import { Readable, Writable } from "node:stream";
import { LauncherError } from "../shared/index.ts";
import type { Backend, ExecSpec } from "./types.ts";

interface ExecCaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

const TIMED_OUT = Symbol("timed out");

export class ExecTimeoutError extends LauncherError {}

const collector = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      chunks.push(Buffer.from(chunk));

      done();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

const withDeadline = async (running: Promise<number>, timeoutMs: number, abort: AbortController) => {
  const timer: { id?: NodeJS.Timeout } = {};
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer.id = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  try {
    const outcome = await Promise.race([running, deadline]);

    if (outcome === TIMED_OUT) {
      abort.abort();
    }

    return outcome;
  } finally {
    clearTimeout(timer.id);
  }
};

export const execCapture = async (
  backend: Pick<Backend, "exec">,
  spec: ExecSpec,
  stdin: string | Buffer = "",
  timeoutMs?: number,
): Promise<ExecCaptureResult> => {
  const stdout = collector();
  const stderr = collector();
  const input = stdin.length === 0 ? [] : [Buffer.from(stdin)];
  const abort = new AbortController();
  const running = backend.exec(spec, {
    stdin: Readable.from(input),
    stdout: stdout.stream,
    stderr: stderr.stream,
    tty: false,
    ...(timeoutMs === undefined ? {} : { signal: abort.signal }),
  });
  const outcome = timeoutMs === undefined ? await running : await withDeadline(running, timeoutMs, abort);

  if (outcome === TIMED_OUT) {
    throw new ExecTimeoutError(`the command in the sandbox did not finish within ${timeoutMs} ms`);
  }

  return { code: outcome, stdout: stdout.text(), stderr: stderr.text() };
};
