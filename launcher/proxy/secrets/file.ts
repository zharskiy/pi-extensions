import type { FileSecret } from "../../config/index.ts";
import {
  expandHome,
  MalformedUrlCredentials,
  readOptionalText,
  type ToolConfigSelect,
  toolConfigValue,
} from "../../shared/index.ts";
import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

const selectOf = (ref: FileSecret): ToolConfigSelect =>
  "pointer" in ref ? { format: "json", key: ref.pointer } : ref;

const selectedValue = (text: string, select: ToolConfigSelect, subject: string) => {
  try {
    return toolConfigValue(text, select);
  } catch (error) {
    if (error instanceof MalformedUrlCredentials) {
      throw unavailable(`${subject} holds ${error.message} at ${select.key}`);
    }

    throw error;
  }
};

export const fileSecret = async (key: string, ref: FileSecret, home: string): Promise<CachedSecret> => {
  const path = expandHome(ref.file, home);
  const text = await readOptionalText(path);

  if (text === undefined) {
    throw unavailable(`file secret for ${key}: ${path} is not readable`);
  }

  const select = selectOf(ref);
  const value = selectedValue(text, select, `file secret for ${key}: ${path}`)?.replace(/[\r\n]+$/, "") ?? "";

  if (value === "") {
    throw unavailable(`file secret for ${key}: ${path} has no ${select.format} value at ${select.key}`);
  }

  return { value };
};
