import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isJsonObject,
  LauncherError,
  parseJsonObject,
  readText,
  stableHash,
  withDirectoryLock,
  writeFileAtomic,
} from "../shared/index.ts";
import { entryMatches, packagesOf } from "./package-source.ts";
import type { JsonObject, PackageChange } from "./types.ts";

const DEFAULT_INDENT = 2;

const PERMISSION_BITS = 0o777;

const modeOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? undefined : info.mode & PERMISSION_BITS;
};

const parseSettings = (path: string, text: string | undefined): JsonObject => {
  if (text === undefined) {
    return {};
  }

  const value = parseJsonObject(text);

  if (value === undefined) {
    throw new LauncherError(
      `${path}: invalid JSON object, the package change was not written back`,
      "fix the file",
    );
  }

  return value;
};

const indentOf = (text: string | undefined) => {
  const match = /\n([ \t]+)\S/.exec(text ?? "");

  return match?.[1] ?? " ".repeat(DEFAULT_INDENT);
};

const withSource = (existing: unknown, source: string) =>
  isJsonObject(existing) ? { ...existing, source } : source;

const changedPackages = (packages: unknown[], change: PackageChange) => {
  const matches = entryMatches(change.source);
  const index = packages.findIndex(matches);
  const kept = packages.filter((entry) => !matches(entry));

  if (change.kind === "remove") {
    return kept;
  }

  return index === -1
    ? [...packages, change.source]
    : packages.flatMap((existing, position) =>
        position === index ? [withSource(existing, change.source)] : matches(existing) ? [] : [existing],
      );
};

const targetOf = async (path: string) => realpath(path).catch(() => path);

const writeBack = async (link: string, change: PackageChange): Promise<{ changed: boolean }> => {
  const path = await targetOf(link);
  const text = await readText(path);
  const settings = parseSettings(path, text);
  const before = packagesOf(settings);
  const after = changedPackages(before, change);

  if (stableHash(before) === stableHash(after) && (settings.packages !== undefined || after.length === 0)) {
    return { changed: false };
  }

  const updated = { ...settings, packages: after };
  const mode = await modeOf(path);

  await writeFileAtomic(path, `${JSON.stringify(updated, null, indentOf(text))}\n`, { mode });

  return { changed: true };
};

export const writeBackPackageChange = (change: PackageChange): Promise<{ changed: boolean }> => {
  const link = join(change.hostAgentDir, "settings.json");

  return withDirectoryLock(`${link}.lock`, () => writeBack(link, change));
};
