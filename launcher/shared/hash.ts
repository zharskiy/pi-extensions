import { createHash } from "node:crypto";
import { isJsonObject } from "./json-file.ts";

export const sha256Hex = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();

  return Object.fromEntries(keys.map((key) => [key, canonical(value[key])]));
};

export const stableHash = (value: unknown) => sha256Hex(JSON.stringify(canonical(value)));

export const repoHash = (repoRoot: string) => sha256Hex(repoRoot);

const SHORT_HASH = 12;

export const shortHash = (hash: string) => hash.slice(0, SHORT_HASH);
