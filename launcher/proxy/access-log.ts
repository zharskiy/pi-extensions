import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface AccessLogEntry {
  time: string;
  user: string;
  repo: string;
  host: string;
  sni?: string;
  decision: "allow" | "deny";
  rule: string;
  reason?: string;
  bytesIn: number;
  bytesOut: number;
}

export interface AccessLog {
  write(entry: AccessLogEntry): void;
  close(): Promise<void>;
}

const PRIVATE_MODE = 0o600;

const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const openStream = (path: string) => {
  const stream = createWriteStream(path, { flags: "a", mode: PRIVATE_MODE });

  stream.on("error", () => undefined);

  return stream;
};

const rotatedLogPath = (path: string) => `${path}.1`;

const moveAside = (path: string) => {
  try {
    renameSync(path, rotatedLogPath(path));
  } catch {
    return;
  }
};

export const capLog = (path: string, limit: number) => {
  if (sizeOf(path) > limit) {
    moveAside(path);
  }
};

export const createAccessLog = (path: string, limit: number): AccessLog => {
  mkdirSync(dirname(path), { recursive: true });

  const state: { stream: WriteStream; bytes: number } = { stream: openStream(path), bytes: sizeOf(path) };

  const rotate = () => {
    state.stream.end();

    moveAside(path);

    state.stream = openStream(path);
    state.bytes = 0;
  };

  return {
    write: (entry) => {
      const line = `${JSON.stringify(entry)}\n`;

      if (state.bytes + line.length > limit && state.bytes > 0) {
        rotate();
      }

      state.stream.write(line);

      state.bytes += Buffer.byteLength(line);
    },
    close: () => new Promise<void>((resolve) => state.stream.end(resolve)),
  };
};
