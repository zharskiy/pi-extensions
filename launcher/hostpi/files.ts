import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, parseJsonObject } from "../shared/index.ts";
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

const parseObject = (path: string, text: string): ReadOutcome => {
  const value = parseJsonObject(text);

  return value === undefined ? { notice: `${path}: invalid JSON object, ignored` } : { value };
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
