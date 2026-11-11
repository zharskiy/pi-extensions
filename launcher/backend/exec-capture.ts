import { Readable, Writable } from "node:stream";
import type { Backend, ExecSpec } from "./types.ts";

interface ExecCaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

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

export const execCapture = async (
  backend: Pick<Backend, "exec">,
  spec: ExecSpec,
  stdin: string | Buffer = "",
): Promise<ExecCaptureResult> => {
  const stdout = collector();
  const stderr = collector();
  const input = stdin.length === 0 ? [] : [Buffer.from(stdin)];
  const code = await backend.exec(spec, {
    stdin: Readable.from(input),
    stdout: stdout.stream,
    stderr: stderr.stream,
    tty: false,
  });

  return { code, stdout: stdout.text(), stderr: stderr.text() };
};
