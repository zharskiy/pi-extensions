import { createHash } from "node:crypto";

export const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();

  return Object.fromEntries(keys.map((key) => [key, canonical(value[key])]));
};

export const stableHash = (value: unknown) => sha256Hex(JSON.stringify(canonical(value)));
