import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AccessLogEntry {
  time: string;
  user: string;
  repo?: string;
  host: string;
  sni?: string;
  decision: "allow" | "deny";
  rule: string;
  reason?: string;
  credential?: string;
  bytesIn: number;
  bytesOut: number;
}

export interface AccessLog {
  write(entry: AccessLogEntry): void;
  close(): Promise<void>;
}

export const createAccessLog = (path: string): AccessLog => {
  mkdirSync(dirname(path), { recursive: true });

  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });

  stream.on("error", () => undefined);

  return {
    write: (entry) => {
      stream.write(`${JSON.stringify(entry)}\n`);
    },
    close: () => new Promise<void>((resolve) => stream.end(resolve)),
  };
};
