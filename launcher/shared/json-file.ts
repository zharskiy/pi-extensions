import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.ts";
import { errorMessage, isMissing, LauncherError } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

interface WriteJsonOptions {
  mode?: number;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const parseJsonObject = (text: string): JsonObject | undefined => {
  const parsed = parseJson(text);

  return isJsonObject(parsed) ? parsed : undefined;
};

export const readOptionalText = (path: string) => readFile(path, "utf8").catch(() => undefined);

export const readJsonObject = async (path: string): Promise<JsonObject | undefined> => {
  const text = await readOptionalText(path);

  return text === undefined ? undefined : parseJsonObject(text);
};

export const readText = async (path: string) => {
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

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const writeJsonFile = (path: string, value: unknown, options: WriteJsonOptions = {}) =>
  writeFileAtomic(path, jsonText(value), options);
