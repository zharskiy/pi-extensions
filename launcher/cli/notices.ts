import { readJsonFile, sha256Hex, stateLayout, writeJsonFile } from "../shared/index.ts";
import { type CliDeps, writeLines } from "./deps.ts";

const KEPT = 64;

const HASH_LENGTH = 16;

const hashOf = (line: string) => sha256Hex(line).slice(0, HASH_LENGTH);

const seenOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export const writeOnce = async (deps: CliDeps, stateDir: string, lines: string[]) => {
  const file = stateLayout(stateDir).seen;
  const seen = seenOf(await readJsonFile<unknown>(file).catch(() => undefined));
  const fresh = [...new Set(lines)].filter((line) => !seen.includes(hashOf(line)));

  if (fresh.length === 0) {
    return;
  }

  writeLines(deps.stderr, fresh);

  await writeJsonFile(file, [...seen, ...fresh.map(hashOf)].slice(-KEPT)).catch(() => undefined);
};
