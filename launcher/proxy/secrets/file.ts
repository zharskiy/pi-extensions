import { readFile } from "node:fs/promises";
import type { FileSecret } from "../../config/index.ts";
import { expandHome, type ToolConfigSelect, toolConfigValue } from "../../shared/index.ts";
import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

const selectOf = (ref: FileSecret): ToolConfigSelect =>
  "pointer" in ref ? { format: "json", key: ref.pointer } : ref;

export const fileSecret = async (key: string, ref: FileSecret, home: string): Promise<CachedSecret> => {
  const path = expandHome(ref.file, home);
  const text = await readFile(path, "utf8").catch(() => undefined);

  if (text === undefined) {
    throw unavailable(`file secret for ${key}: ${path} is not readable`);
  }

  const select = selectOf(ref);
  const value = toolConfigValue(text, select)?.replace(/[\r\n]+$/, "") ?? "";

  if (value === "") {
    throw unavailable(`file secret for ${key}: ${path} has no ${select.format} value at ${select.key}`);
  }

  return { value };
};
