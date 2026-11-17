import { readJsonFile, sha256Hex, stateLayout, writeJsonFile } from "../shared/index.ts";
import { type CliDeps, noticeLine, writeNotices } from "./deps.ts";

interface NoticeScope {
  stateDir: string;
  repoHash: string;
}

const KEPT_PER_REPO = 64;

const HASH_LENGTH = 16;

const hashOf = (notice: string) => sha256Hex(noticeLine(notice)).slice(0, HASH_LENGTH);

const seenOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export const writeOnce = async (deps: CliDeps, scope: NoticeScope, notices: string[]) => {
  const file = stateLayout(scope.stateDir).repo(scope.repoHash).seen;
  const seen = seenOf(await readJsonFile<unknown>(file).catch(() => undefined));
  const fresh = [...new Set(notices)].filter((notice) => !seen.includes(hashOf(notice)));

  if (fresh.length === 0) {
    return;
  }

  writeNotices(deps, fresh);

  await writeJsonFile(file, [...seen, ...fresh.map(hashOf)].slice(-KEPT_PER_REPO)).catch(() => undefined);
};
