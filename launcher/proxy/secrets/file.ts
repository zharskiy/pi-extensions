import { readFile } from "node:fs/promises";
import { expandHome } from "../../shared/index.ts";
import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

const unescapeToken = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");

const step = (value: unknown, token: string) =>
  typeof value === "object" && value !== null && Object.hasOwn(value, token)
    ? (value as Record<string, unknown>)[token]
    : undefined;

const pointerValue = (document: unknown, pointer: string) =>
  pointer
    .split("/")
    .slice(1)
    .map(unescapeToken)
    .reduce<unknown>((value, token) => step(value, token), document);

const parse = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const fileSecret = async (
  key: string,
  ref: { file: string; pointer: string },
  home: string,
): Promise<CachedSecret> => {
  const path = expandHome(ref.file, home);
  const text = await readFile(path, "utf8").catch(() => undefined);

  if (text === undefined) {
    throw unavailable(`file secret for ${key}: ${path} is not readable`);
  }

  const value = pointerValue(parse(text), ref.pointer);

  const trimmed = typeof value === "string" ? value.replace(/[\r\n]+$/, "") : "";

  if (trimmed === "") {
    throw unavailable(`file secret for ${key}: ${path} has no string at ${ref.pointer}`);
  }

  return { value: trimmed };
};
