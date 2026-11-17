import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import {
  BUILT_IN_EXTENSION_FILES,
  errorMessage,
  isMissing,
  PERMISSION_BITS,
  PRIVATE_FILE_MODE,
  parseJsonObject,
  readJsonObject,
  SETTINGS_FILE_NAME,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import { type PackagePin, pinHostPackages } from "./host-packages.ts";
import { prepareHostSettings, sandboxSettings } from "./merge-settings.ts";
import { refreshPackages } from "./package-refresh.ts";
import type { SyncInput, SyncResult } from "./types.ts";
import { readVolumeText, removeVolumeFile, writeVolumeFile } from "./volume.ts";
import {
  allowlistChanged,
  allowlistHash,
  applyChanges,
  type Baseline,
  baselineRecord,
  changeLine,
  copiedOf,
  mergeFile,
  parseBaseline,
  parseVolumeText,
  type SyncedFile,
  syncedFilesOf,
  syncedValues,
} from "./write-back.ts";

interface HostFile {
  path: string;
  exists: boolean;
  value?: JsonObject;
  mode?: number;
}

interface CopiedFile {
  name: string;
  value?: JsonObject;
  notices: string[];
}

interface PriorSync {
  path: string;
  copied: readonly string[];
}

interface FileOutcome {
  changes: string[];
  notices: string[];
}

const LOCK_TIMEOUT_MS = 30_000;

const readHostFile = async (hostAgentDir: string, name: string): Promise<HostFile> => {
  const linked = join(hostAgentDir, name);
  const path = await realpath(linked).catch(() => linked);

  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);

    return { path, exists: true, value: parseJsonObject(text), mode: info.mode & PERMISSION_BITS };
  } catch (error) {
    if (isMissing(error)) {
      return { path, exists: false, value: {} };
    }

    throw error;
  }
};

const writeBackFile = async (
  input: SyncInput,
  baseline: Baseline,
  file: SyncedFile,
): Promise<FileOutcome> => {
  const text = await readVolumeText(
    input.backend,
    input.containerId,
    file.name,
    file.maxBytes,
    input.readTimeoutMs,
  );
  const volume = parseVolumeText(file, text);

  if ("notices" in volume) {
    return { changes: [], notices: volume.notices };
  }

  const host = await readHostFile(input.hostAgentDir, file.name);

  if (host.value === undefined) {
    return { changes: [], notices: [`${file.name} on the host is not a JSON object; not written back`] };
  }

  const merged = mergeFile(file, {
    baseline: baseline[file.name] ?? {},
    volume: volume.value,
    host: host.value,
  });

  if (merged.changes.length === 0) {
    return { changes: [], notices: merged.notices };
  }

  await writeJsonFile(host.path, applyChanges(host.value, merged.changes), { mode: host.mode });

  return { changes: merged.changes.map((change) => changeLine(file, change)), notices: merged.notices };
};

const safeWriteBack = (input: SyncInput, baseline: Baseline, file: SyncedFile) =>
  writeBackFile(input, baseline, file).catch(
    (error: unknown): FileOutcome => ({
      changes: [],
      notices: [`warning: ${file.name} was not written back: ${errorMessage(error)}`],
    }),
  );

interface Allowlist {
  synced: readonly SyncedFile[];
  hash: string;
}

const LIST_CHANGED =
  "the write-back list changed; nothing is written back from sessions started under the old list";

const writeBack = async (input: SyncInput, allowlist: Allowlist, record: unknown) => {
  const baseline = parseBaseline(record, allowlist.synced, allowlist.hash);

  if (baseline === undefined) {
    return { changes: [], notices: allowlistChanged(record, allowlist.hash) ? [LIST_CHANGED] : [] };
  }

  const outcomes = await Promise.all(allowlist.synced.map((file) => safeWriteBack(input, baseline, file)));

  return {
    changes: outcomes.flatMap((outcome) => outcome.changes),
    notices: outcomes.flatMap((outcome) => outcome.notices),
  };
};

const syncSettings = async (input: SyncInput) => {
  const host = await readHostFile(input.hostAgentDir, SETTINGS_FILE_NAME);
  const prepared = prepareHostSettings(host.value ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.repoRoot],
  });
  const pinned = Array.isArray(prepared.settings.packages)
    ? await pinHostPackages(prepared.settings.packages, input.hostAgentDir)
    : { packages: undefined, pins: [] };
  const written = sandboxSettings(
    pinned.packages === undefined ? prepared.settings : { ...prepared.settings, packages: pinned.packages },
  );

  await writeVolumeFile(input.backend, input.containerId, SETTINGS_FILE_NAME, written);

  return { name: SETTINGS_FILE_NAME, value: written, notices: prepared.notices, pins: pinned.pins };
};

const followHostPackages = (input: SyncInput, pins: PackagePin[]) =>
  refreshPackages({
    backend: input.backend,
    containerId: input.containerId,
    stampPath: stateLayout(input.stateDir).repo(input.repoHash).syncPackages,
    pins,
    othersLive: input.othersLive ?? (() => Promise.resolve(false)),
    removeTimeoutMs: input.removeTimeoutMs,
  }).catch((error: unknown) => [
    `warning: the sandbox packages were not refreshed to follow the host: ${errorMessage(error)}`,
  ]);

const syncExtensionFile = async (input: SyncInput, name: string): Promise<CopiedFile> => {
  const host = await readHostFile(input.hostAgentDir, name);

  if (host.value === undefined || !host.exists) {
    await removeVolumeFile(input.backend, input.containerId, name);

    return {
      name,
      notices: host.exists ? [`${name} on the host is not a JSON object; not copied into the sandbox`] : [],
    };
  }

  await writeVolumeFile(input.backend, input.containerId, name, host.value);

  return { name, value: host.value, notices: [] };
};

const copiedNames = (synced: readonly SyncedFile[]) => [
  ...new Set([
    ...BUILT_IN_EXTENSION_FILES,
    ...synced.map((file) => file.name).filter((name) => name !== SETTINGS_FILE_NAME),
  ]),
];

const baselineOf = (synced: readonly SyncedFile[], copied: readonly CopiedFile[]): Baseline =>
  Object.fromEntries(
    synced.map((file) => [
      file.name,
      syncedValues(file, copied.find((entry) => entry.name === file.name)?.value),
    ]),
  );

const removeStale = (input: SyncInput, stale: readonly string[]) =>
  Promise.all(stale.map((name) => removeVolumeFile(input.backend, input.containerId, name)));

const syncIn = async (input: SyncInput, allowlist: Allowlist, prior: PriorSync) => {
  const names = copiedNames(allowlist.synced);
  const settings = syncSettings(input);
  const [copied] = await Promise.all([
    Promise.all([settings, ...names.map((name) => syncExtensionFile(input, name))]),
    removeStale(
      input,
      prior.copied.filter((name) => !names.includes(name)),
    ),
  ]);
  const baseline = baselineOf(allowlist.synced, copied);
  const kept = copied
    .filter((file) => file.value !== undefined && file.name !== SETTINGS_FILE_NAME)
    .map((file) => file.name);

  await writeJsonFile(prior.path, baselineRecord(baseline, allowlist.hash, kept), {
    mode: PRIVATE_FILE_MODE,
  });

  const refreshed =
    input.refreshPackages === true ? await followHostPackages(input, (await settings).pins) : [];

  return [...copied.flatMap((outcome) => outcome.notices), ...refreshed];
};

const keepCopiedOnly = (prior: PriorSync, names: readonly string[]) =>
  writeJsonFile(
    prior.path,
    { copied: [...new Set([...prior.copied, ...names])] },
    { mode: PRIVATE_FILE_MODE },
  ).catch(() => rm(prior.path, { force: true }));

const syncWithBaseline = async (input: SyncInput, allowlist: Allowlist, prior: PriorSync) => {
  try {
    return await syncIn(input, allowlist, prior);
  } catch (error) {
    await keepCopiedOnly(prior, copiedNames(allowlist.synced));

    throw error;
  }
};

const syncVolume = async (input: SyncInput): Promise<SyncResult> => {
  const baselinePath = stateLayout(input.stateDir).repo(input.repoHash).syncBaseline;
  const record = await readJsonObject(baselinePath);
  const allowlist = { synced: syncedFilesOf(input.allowlist), hash: allowlistHash(input.allowlist) };
  const returned = await writeBack(input, allowlist, record);
  const prior = { path: baselinePath, copied: copiedOf(record) };
  const notices = await syncWithBaseline(input, allowlist, prior).catch((error: unknown) => [
    `warning: the sandbox copies of the agent settings were not refreshed: ${errorMessage(error)}`,
    "warning: preference changes made in the sandbox from now on will not be written back to the host",
  ]);

  return { changes: returned.changes, notices: [...returned.notices, ...notices] };
};

export const syncVolumeFiles = (input: SyncInput): Promise<SyncResult> =>
  withFileLock(stateLayout(input.stateDir).repo(input.repoHash).syncLock, () => syncVolume(input), {
    timeoutMs: LOCK_TIMEOUT_MS,
  });
