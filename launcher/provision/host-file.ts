import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import { parseJsonObject } from "../shared/index.ts";

export interface HostFile {
  path: string;
  exists: boolean;
  value?: JsonObject;
  mode?: number;
}

const PERMISSION_BITS = 0o777;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export const readHostFile = async (hostAgentDir: string, name: string): Promise<HostFile> => {
  const linked = join(hostAgentDir, name);
  const path = await realpath(linked).catch(() => linked);

  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);

    return { path, exists: true, value: parseJsonObject(text), mode: info.mode & PERMISSION_BITS };
  } catch (error) {
    if (isMissing(error)) {
      return { path, exists: false, value: {} };
    }

    throw error;
  }
};

export const jsonText = (value: JsonObject) => `${JSON.stringify(value, null, 2)}\n`;
