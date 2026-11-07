import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import { type JsonObject, packageSourceKey, sourceOfEntry } from "../hostpi/index.ts";
import { expandHome, readJsonFile, stableHash, stateLayout, writeJsonFile } from "../shared/index.ts";
import { hasBakedPackage, keepBakedPackage, mergeTopLevel, prepareHostSettings } from "./merge-settings.ts";
import type { PackageDiff, SyncInput, SyncResult } from "./types.ts";
import { readVolumeFile, writeVolumeFile } from "./volume.ts";

export { mergeTopLevel };

interface WritableFile {
  name: "settings.json" | "mcp.json";
  host: JsonObject;
  adjust: (merged: JsonObject, volume: JsonObject | undefined) => JsonObject;
}

const readBase = async (path: string) => {
  try {
    return await readJsonFile<JsonObject>(path);
  } catch {
    return undefined;
  }
};

const syncFile = async (input: SyncInput, file: WritableFile): Promise<string[]> => {
  const basePath = join(stateLayout(input.stateDir).sync(input.repoHash), file.name);
  const base = await readBase(basePath);
  const volume = await readVolumeFile(input.backend, input.containerId, file.name);
  const merged = file.adjust(mergeTopLevel(base, file.host, volume.value), volume.value);

  if (volume.value === undefined || stableHash(merged) !== stableHash(volume.value)) {
    await writeVolumeFile(input.backend, input.containerId, file.name, merged);
  }

  await writeJsonFile(basePath, file.host);

  return volume.invalid
    ? [`${file.name} in the sandbox volume was not valid JSON; replaced with the host copy`]
    : [];
};

export const syncWritableFiles = async (input: SyncInput): Promise<SyncResult> => {
  const volumeSettings = await readVolumeFile(input.backend, input.containerId, "settings.json");
  const prepared = prepareHostSettings(input.hostSettings ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.repoRoot, ...input.config.mounts.extraReadOnly.map((path) => expandHome(path))],
    bakedInVolume: hasBakedPackage(volumeSettings.value),
  });
  const settingsNotices = await syncFile(input, {
    name: "settings.json",
    host: prepared.settings,
    adjust: keepBakedPackage,
  });
  const mcpNotices = await syncFile(input, { name: "mcp.json", host: input.mcp, adjust: (merged) => merged });

  return { notices: [...prepared.notices, ...settingsNotices, ...mcpNotices] };
};

export const readVolumeSettings = async (backend: Backend, containerId: string) =>
  (await readVolumeFile(backend, containerId, "settings.json")).value;

const findPackage = (settings: JsonObject | undefined, source: string) => {
  const key = packageSourceKey(source);
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];

  return packages.find((entry) => {
    const own = sourceOfEntry(entry);

    return own !== undefined && packageSourceKey(own) === key;
  });
};

export const packageChangeFor = (
  before: JsonObject | undefined,
  after: JsonObject | undefined,
  source: string,
): PackageDiff | undefined => {
  const previous = findPackage(before, source);
  const next = findPackage(after, source);

  if (next !== undefined) {
    return previous !== undefined && stableHash(previous) === stableHash(next)
      ? undefined
      : { kind: "install", entry: next };
  }

  return previous === undefined ? undefined : { kind: "remove" };
};
