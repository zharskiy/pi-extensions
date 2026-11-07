import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.ts";
import { errorMessage, LauncherError } from "./errors.ts";

interface WriteJsonOptions {
  mode?: number;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const readText = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }

    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

export const readJsonFile = async <T>(path: string): Promise<T | undefined> => {
  const text = await readText(path);

  if (text === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new LauncherError(`${path}: invalid JSON (${errorMessage(error)})`, "fix or remove the file");
  }
};

export const writeJsonFile = (path: string, value: unknown, options: WriteJsonOptions = {}) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
