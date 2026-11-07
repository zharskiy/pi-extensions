import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../shared/index.ts";
import type { HostPiFiles, JsonObject } from "./types.ts";

type FileKey = "auth" | "models" | "mcp" | "settings";

interface ReadOutcome {
  value?: JsonObject;
  notice?: string;
}

const FILES: Array<[FileKey, string]> = [
  ["auth", "auth.json"],
  ["models", "models.json"],
  ["mcp", "mcp.json"],
  ["settings", "settings.json"],
];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseObject = (path: string, text: string): ReadOutcome => {
  try {
    const value: unknown = JSON.parse(text);

    return isObject(value) ? { value } : { notice: `${path}: not a JSON object, ignored` };
  } catch {
    return { notice: `${path}: invalid JSON, ignored` };
  }
};

const readObject = async (path: string): Promise<ReadOutcome> => {
  try {
    return parseObject(path, await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    return { notice: `${path}: ${errorMessage(error)}, ignored` };
  }
};

export const readHostPiFiles = async (agentDir: string): Promise<HostPiFiles> => {
  const outcomes = await Promise.all(FILES.map(([, name]) => readObject(join(agentDir, name))));
  const values = Object.fromEntries(FILES.map(([key], index) => [key, outcomes[index]?.value]));
  const notices = outcomes.flatMap((outcome) => (outcome.notice === undefined ? [] : [outcome.notice]));

  return { agentDir, ...values, notices };
};
