import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import {
  BUILT_IN_EXTENSION_FILES,
  errorMessage,
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
import { sourceOfEntry } from "./package-source.ts";
import type { PackageChanges, SyncInput, SyncResult } from "./types.ts";
import { readVolumeText, removeVolumeFile, VolumeUnchangedError, writeVolumeFile } from "./volume.ts";
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
  baseline?: Baseline;
}

interface FileOutcome {
  changes: string[];
  notices: string[];
  entry: [string, JsonObject];
}

const LOCK_TIMEOUT_MS = 30_000;

const PRIVATE_FILE_MODE = 0o600;

const PERMISSION_BITS = 0o777;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

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
  const entry = baseline[file.name] ?? {};
  const unchanged = (notices: string[]): FileOutcome => ({ changes: [], notices, entry: [file.name, entry] });

  if ("notices" in volume) {
    return unchanged(volume.notices);
  }

  const host = await readHostFile(input.hostAgentDir, file.name);

  if (host.value === undefined) {
    return unchanged([`${file.name} on the host is not a JSON object; not written back`]);
  }

  const merged = mergeFile(file, { baseline: entry, volume: volume.value, host: host.value });

  if (merged.changes.length === 0) {
    return unchanged(merged.notices);
  }

  await writeJsonFile(host.path, applyChanges(host.value, merged.changes), { mode: host.mode });

  return {
    changes: merged.changes.map((change) => changeLine(file, change)),
    notices: merged.notices,
    entry: [file.name, applyChanges(entry, merged.changes)],
  };
};

const safeWriteBack = (input: SyncInput, baseline: Baseline, file: SyncedFile) =>
  writeBackFile(input, baseline, file).catch(
    (error: unknown): FileOutcome => ({
      changes: [],
      notices: [`warning: ${file.name} was not written back: ${errorMessage(error)}`],
      entry: [file.name, baseline[file.name] ?? {}],
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
    return {
      changes: [],
      notices: allowlistChanged(record, allowlist.hash) ? [LIST_CHANGED] : [],
      baseline: undefined,
    };
  }

  const known = allowlist.synced.filter((file) => Object.hasOwn(baseline, file.name));
  const outcomes = await Promise.all(known.map((file) => safeWriteBack(input, baseline, file)));

  return {
    changes: outcomes.flatMap((outcome) => outcome.changes),
    notices: outcomes.flatMap((outcome) => outcome.notices),
    baseline: Object.fromEntries(outcomes.map((outcome) => outcome.entry)),
  };
};

const beforeVolume = <T>(work: Promise<T>) =>
  work.catch((error: unknown) => {
    throw error instanceof VolumeUnchangedError ? error : new VolumeUnchangedError(errorMessage(error));
  });

const settingsFor = async (input: SyncInput) => {
  const host = await readHostFile(input.hostAgentDir, SETTINGS_FILE_NAME);
  const prepared = prepareHostSettings(host.value ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.workspaceRoot],
    home: input.hostHome,
  });
  const pinned = Array.isArray(prepared.settings.packages)
    ? await pinHostPackages(prepared.settings.packages, input.hostAgentDir)
    : { packages: undefined, pins: [] };
  const written = sandboxSettings(
    pinned.packages === undefined ? prepared.settings : { ...prepared.settings, packages: pinned.packages },
  );

  return { name: SETTINGS_FILE_NAME, value: written, notices: prepared.notices, pins: pinned.pins };
};

const syncSettings = async (input: SyncInput) => {
  const settings = await beforeVolume(settingsFor(input));

  await writeVolumeFile(input.backend, input.containerId, SETTINGS_FILE_NAME, settings.value);

  return settings;
};

const followHostPackages = (input: SyncInput, pins: PackagePin[]) =>
  refreshPackages({
    backend: input.backend,
    containerId: input.containerId,
    stampPath: stateLayout(input.stateDir).sync.packages,
    pins,
    othersLive: input.othersLive ?? (() => Promise.resolve(false)),
    removeTimeoutMs: input.removeTimeoutMs,
  }).catch((error: unknown) => ({
    notices: [`warning: the sandbox packages were not refreshed to follow the host: ${errorMessage(error)}`],
    changed: [],
  }));

const writtenSources = (settings: JsonObject) =>
  (Array.isArray(settings.packages) ? settings.packages : []).flatMap((entry) => {
    const source = sourceOfEntry(entry);

    return source === undefined ? [] : [source];
  });

interface SyncedIn {
  notices: string[];
  packages: PackageChanges;
}

const syncExtensionFile = async (input: SyncInput, name: string): Promise<CopiedFile> => {
  const host = await beforeVolume(readHostFile(input.hostAgentDir, name));

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

type Copy = PromiseSettledResult<CopiedFile>;

const entryAfter = (
  file: SyncedFile,
  copy: Copy | undefined,
  prior: Baseline | undefined,
): Array<[string, JsonObject]> => {
  if (copy?.status === "fulfilled") {
    return [[file.name, syncedValues(file, copy.value.value)]];
  }

  const kept = prior?.[file.name];

  return copy?.reason instanceof VolumeUnchangedError && kept !== undefined ? [[file.name, kept]] : [];
};

const baselineAfter = (
  synced: readonly SyncedFile[],
  names: readonly string[],
  copies: readonly Copy[],
  prior: Baseline | undefined,
): Baseline =>
  Object.fromEntries(synced.flatMap((file) => entryAfter(file, copies[names.indexOf(file.name)], prior)));

const removeStale = (input: SyncInput, stale: readonly string[]) =>
  Promise.all(stale.map((name) => removeVolumeFile(input.backend, input.containerId, name)));

class SyncInError extends Error {
  readonly lost: readonly string[];

  constructor(message: string, lost: readonly string[]) {
    super(message);

    this.lost = lost;
  }
}

const recordBaseline = (path: string, record: unknown) =>
  writeJsonFile(path, record, { mode: PRIVATE_FILE_MODE }).catch(async (error: unknown) => {
    await rm(path, { force: true });

    throw error;
  });

const syncIn = async (input: SyncInput, allowlist: Allowlist, prior: PriorSync): Promise<SyncedIn> => {
  const names = copiedNames(allowlist.synced);
  const settings = syncSettings(input);
  const [copies, [removal]] = await Promise.all([
    Promise.allSettled([settings, ...names.map((name) => syncExtensionFile(input, name))]),
    Promise.allSettled([
      removeStale(
        input,
        prior.copied.filter((name) => !names.includes(name)),
      ),
    ]),
  ]);
  const failure = [...copies, removal].find((outcome) => outcome.status === "rejected");
  const baseline = baselineAfter(
    allowlist.synced,
    [SETTINGS_FILE_NAME, ...names],
    copies,
    failure === undefined ? undefined : prior.baseline,
  );
  const kept = copies.flatMap((copy) =>
    copy.status === "fulfilled" && copy.value.value !== undefined && copy.value.name !== SETTINGS_FILE_NAME
      ? [copy.value.name]
      : [],
  );
  const copied = failure === undefined ? kept : [...new Set([...prior.copied, ...names])];

  await recordBaseline(prior.path, baselineRecord(baseline, allowlist.hash, copied));

  if (failure !== undefined) {
    const lost = allowlist.synced.map((file) => file.name).filter((name) => !Object.hasOwn(baseline, name));

    throw new SyncInError(errorMessage(failure.reason), lost);
  }

  const written = await settings;
  const refreshed =
    input.refreshPackages === true
      ? await followHostPackages(input, written.pins)
      : { notices: [], changed: [] };

  return {
    notices: [
      ...copies.flatMap((copy) => (copy.status === "fulfilled" ? copy.value.notices : [])),
      ...refreshed.notices,
    ],
    packages: { sources: writtenSources(written.value), changed: refreshed.changed },
  };
};

const lostNotice = (lost: readonly string[], synced: readonly SyncedFile[]) =>
  lost.length === synced.length
    ? "warning: preference changes made in the sandbox from now on will not be written back to the host"
    : `warning: preference changes made in the sandbox to ${lost.join(", ")} from now on will not be written back to the host`;

const syncFailedNotices = (error: unknown, synced: readonly SyncedFile[]) => {
  const lost = error instanceof SyncInError ? error.lost : synced.map((file) => file.name);
  const refreshed = `warning: the sandbox copies of the agent settings were not refreshed: ${errorMessage(error)}`;

  return lost.length === 0 ? [refreshed] : [refreshed, lostNotice(lost, synced)];
};

const syncVolume = async (input: SyncInput): Promise<SyncResult> => {
  const baselinePath = stateLayout(input.stateDir).sync.baseline;
  const record = await readJsonObject(baselinePath);
  const allowlist = { synced: syncedFilesOf(input.allowlist), hash: allowlistHash(input.allowlist) };
  const returned = await writeBack(input, allowlist, record);
  const prior = { path: baselinePath, copied: copiedOf(record), baseline: returned.baseline };
  const synced = await syncIn(input, allowlist, prior).catch(
    (error: unknown): Partial<SyncedIn> & { notices: string[] } => ({
      notices: syncFailedNotices(error, allowlist.synced),
    }),
  );

  return {
    changes: returned.changes,
    notices: [...returned.notices, ...synced.notices],
    packages: synced.packages,
  };
};

export const syncVolumeFiles = (input: SyncInput): Promise<SyncResult> =>
  withFileLock(stateLayout(input.stateDir).sync.lock, () => syncVolume(input), {
    timeoutMs: LOCK_TIMEOUT_MS,
  });
