import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, LauncherError, stableHash, writeFileAtomic } from "../shared/index.ts";
import { isJsonObject } from "./json.ts";
import { entryMatches, packagesOf } from "./package-source.ts";
import type { JsonObject, PackageChange } from "./types.ts";

const DEFAULT_INDENT = 2;

const PERMISSION_BITS = 0o777;

const modeOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info === undefined ? undefined : info.mode & PERMISSION_BITS;
};

const readSettingsText = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

const parseSettings = (path: string, text: string | undefined): JsonObject => {
  if (text === undefined) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(text);

    if (isJsonObject(value)) {
      return value;
    }
  } catch {
    throw new LauncherError(`${path}: invalid JSON, the package change was not written back`, "fix the file");
  }

  throw new LauncherError(
    `${path}: not a JSON object, the package change was not written back`,
    "fix the file",
  );
};

const indentOf = (text: string | undefined) => {
  const match = /\n([ \t]+)\S/.exec(text ?? "");

  return match?.[1] ?? " ".repeat(DEFAULT_INDENT);
};

const changedPackages = (packages: unknown[], change: PackageChange) => {
  const matches = entryMatches(change.source);
  const index = packages.findIndex(matches);
  const kept = packages.filter((entry) => !matches(entry));

  if (change.kind === "remove") {
    return kept;
  }

  const entry = change.entry ?? change.source;

  return index === -1
    ? [...packages, entry]
    : packages.flatMap((existing, position) =>
        position === index ? [entry] : matches(existing) ? [] : [existing],
      );
};

const targetOf = async (path: string) => realpath(path).catch(() => path);

export const writeBackPackageChange = async (change: PackageChange): Promise<{ changed: boolean }> => {
  const path = await targetOf(join(change.hostAgentDir, "settings.json"));
  const text = await readSettingsText(path);
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
