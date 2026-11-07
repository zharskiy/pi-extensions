import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import { entryMatches, type JsonObject, packagesOf, sourceOfEntry } from "../hostpi/index.ts";
import {
  expandHome,
  readJsonFile,
  stableHash,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import {
  hasBakedPackage,
  keepBakedPackage,
  mergeTopLevel,
  prepareHostSettings,
  withHostOwnedSettings,
} from "./merge-settings.ts";
import type { PackageDiff, PackageRequest, SyncInput, SyncResult } from "./types.ts";
import { readVolumeFile, writeVolumeFile } from "./volume.ts";

export { mergeTopLevel };

const PRIVATE_MODE = 0o600;

const LOCK_TIMEOUT_MS = 30_000;

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

  await writeJsonFile(basePath, file.host, { mode: PRIVATE_MODE });

  return volume.invalid
    ? [`${file.name} in the sandbox volume was not valid JSON; replaced with the host copy`]
    : [];
};

const syncBoth = async (input: SyncInput): Promise<SyncResult> => {
  const volumeSettings = await readVolumeFile(input.backend, input.containerId, "settings.json");
  const prepared = prepareHostSettings(input.hostSettings ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.repoRoot, ...input.config.mounts.extraReadOnly.map((path) => expandHome(path))],
    bakedInVolume: hasBakedPackage(volumeSettings.value),
  });
  const settingsNotices = await syncFile(input, {
    name: "settings.json",
    host: prepared.settings,
    adjust: (merged, volume) => keepBakedPackage(withHostOwnedSettings(merged, prepared.settings), volume),
  });
  const mcpNotices = await syncFile(input, { name: "mcp.json", host: input.mcp, adjust: (merged) => merged });

  return { notices: [...prepared.notices, ...settingsNotices, ...mcpNotices] };
};

export const syncWritableFiles = (input: SyncInput): Promise<SyncResult> =>
  withFileLock(join(stateLayout(input.stateDir).sync(input.repoHash), "sync.lock"), () => syncBoth(input), {
    timeoutMs: LOCK_TIMEOUT_MS,
  });

export const readVolumeSettings = async (backend: Backend, containerId: string) =>
  (await readVolumeFile(backend, containerId, "settings.json")).value;

const matchingSources = (settings: JsonObject | undefined, source: string) =>
  packagesOf(settings)
    .filter(entryMatches(source))
    .flatMap((entry) => sourceOfEntry(entry) ?? []);

const installChange = (previous: string[], next: string[], source: string): PackageDiff | undefined => {
  if (next.includes(source)) {
    return previous.includes(source) ? undefined : { kind: "install" };
  }

  const [recorded] = next;

  return recorded === undefined ? undefined : { kind: "mismatch", recorded };
};

export const packageChangeFor = (
  before: JsonObject | undefined,
  after: JsonObject | undefined,
  request: PackageRequest,
): PackageDiff | undefined => {
  const previous = matchingSources(before, request.source);
  const next = matchingSources(after, request.source);

  if (request.kind === "install") {
    return installChange(previous, next, request.source);
  }

  return previous.length > 0 && next.length === 0 ? { kind: "remove" } : undefined;
};
