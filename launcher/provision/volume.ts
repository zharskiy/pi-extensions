import { posix } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Backend } from "../backend/index.ts";
import type { JsonObject } from "../hostpi/index.ts";
import { GUEST_PATHS, LauncherError } from "../shared/index.ts";

export interface VolumeRead {
  value?: JsonObject;
  invalid: boolean;
}

const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1.pi-sandbox-tmp" && mv "$1.pi-sandbox-tmp" "$1"';

const guestPath = (name: string) => posix.join(GUEST_PATHS.agentDir, name);

export const collector = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.from(chunk));

      callback();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

const parse = (text: string): VolumeRead => {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { value: value as JsonObject, invalid: false }
      : { invalid: true };
  } catch {
    return { invalid: true };
  }
};

export const readVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
): Promise<VolumeRead> => {
  const stdout = collector();
  const code = await backend.exec(
    { containerId, command: ["cat", guestPath(name)], env: {}, workdir: "/" },
    { stdout: stdout.stream, stderr: collector().stream, tty: false },
  );

  const text = stdout.text();

  return code === 0 && text.trim() !== "" ? parse(text) : { invalid: false };
};

export const writeVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
  value: JsonObject,
) => {
  const code = await backend.exec(
    { containerId, command: ["sh", "-c", WRITE_SCRIPT, "sh", guestPath(name)], env: {}, workdir: "/" },
    {
      stdin: Readable.from([Buffer.from(`${JSON.stringify(value, null, 2)}\n`)]),
      stdout: collector().stream,
      stderr: collector().stream,
      tty: false,
    },
  );

  if (code !== 0) {
    throw new LauncherError(`${name}: could not write it into the sandbox volume (exit ${code})`);
  }
};
