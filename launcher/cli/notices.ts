import { readJsonObject, sha256Hex, stateLayout, writeJsonFile } from "../shared/index.ts";
import { type CliDeps, writeLines } from "./deps.ts";

interface NoticeScope {
  stateDir: string;
  repoHash: string;
}

const KEPT_PER_REPO = 64;

const HASH_LENGTH = 16;

const hashOf = (line: string) => sha256Hex(line).slice(0, HASH_LENGTH);

const seenOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export const writeOnce = async (deps: CliDeps, scope: NoticeScope, lines: string[]) => {
  const file = stateLayout(scope.stateDir).seen;
  const record = (await readJsonObject(file).catch(() => undefined)) ?? {};
  const seen = seenOf(record[scope.repoHash]);
  const fresh = [...new Set(lines)].filter((line) => !seen.includes(hashOf(line)));

  if (fresh.length === 0) {
    return;
  }

  writeLines(deps.stderr, fresh);

  const kept = [...seen, ...fresh.map(hashOf)].slice(-KEPT_PER_REPO);

  await writeJsonFile(file, { ...record, [scope.repoHash]: kept }).catch(() => undefined);
};
