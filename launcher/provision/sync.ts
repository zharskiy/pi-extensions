import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import {
  errorMessage,
  parseJsonObject,
  readJsonObject,
  stateLayout,
  withFileLock,
  writeFileAtomic,
  writeJsonFile,
} from "../shared/index.ts";
import { prepareHostSettings, sandboxSettings } from "./merge-settings.ts";
import type { SyncInput, SyncResult } from "./types.ts";
import { readVolumeText, removeVolumeFile, writeVolumeFile } from "./volume.ts";
import {
  applyChanges,
  type Baseline,
  baselineRecord,
  changeLine,
  EXTENSION_FILES,
  mergeFile,
  parseBaseline,
  parseVolumeText,
  SETTINGS_FILE,
  SYNCED_FILES,
  type SyncedFile,
  syncedValues,
} from "./write-back.ts";

interface HostFile {
  path: string;
  exists: boolean;
  value?: JsonObject;
  mode?: number;
}

interface FileOutcome {
  changes: string[];
  notices: string[];
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

const jsonText = (value: JsonObject) => `${JSON.stringify(value, null, 2)}\n`;

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

  await writeFileAtomic(host.path, jsonText(applyChanges(host.value, merged.changes)), { mode: host.mode });

  return { changes: merged.changes.map((change) => changeLine(file, change)), notices: merged.notices };
};

const safeWriteBack = (input: SyncInput, baseline: Baseline, file: SyncedFile) =>
  writeBackFile(input, baseline, file).catch(
    (error: unknown): FileOutcome => ({
      changes: [],
      notices: [`warning: ${file.name} was not written back: ${errorMessage(error)}`],
    }),
  );

const writeBack = async (input: SyncInput, baselinePath: string): Promise<FileOutcome> => {
  const baseline = parseBaseline(await readJsonObject(baselinePath));

  if (baseline === undefined) {
    return { changes: [], notices: [] };
  }

  const outcomes = await Promise.all(SYNCED_FILES.map((file) => safeWriteBack(input, baseline, file)));

  return {
    changes: outcomes.flatMap((outcome) => outcome.changes),
    notices: outcomes.flatMap((outcome) => outcome.notices),
  };
};

const syncSettings = async (input: SyncInput) => {
  const host = await readHostFile(input.hostAgentDir, SETTINGS_FILE.name);
  const prepared = prepareHostSettings(host.value ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.repoRoot],
  });
  const written = sandboxSettings(prepared.settings);

  await writeVolumeFile(input.backend, input.containerId, SETTINGS_FILE.name, written);

  return { values: syncedValues(SETTINGS_FILE, written), notices: prepared.notices };
};

const syncExtensionFile = async (input: SyncInput, file: SyncedFile) => {
  const host = await readHostFile(input.hostAgentDir, file.name);

  if (host.value === undefined || !host.exists) {
    await removeVolumeFile(input.backend, input.containerId, file.name);

    return {
      values: {},
      notices: host.exists
        ? [`${file.name} on the host is not a JSON object; not copied into the sandbox`]
        : [],
    };
  }

  await writeVolumeFile(input.backend, input.containerId, file.name, host.value);

  return { values: syncedValues(file, host.value), notices: [] };
};

const syncIn = async (input: SyncInput, baselinePath: string) => {
  const synced = await Promise.all([
    syncSettings(input),
    ...EXTENSION_FILES.map((file) => syncExtensionFile(input, file)),
  ]);
  const baseline = Object.fromEntries(
    SYNCED_FILES.map((file, index) => [file.name, synced[index]?.values ?? {}]),
  );

  await writeJsonFile(baselinePath, baselineRecord(baseline), { mode: PRIVATE_FILE_MODE });

  return synced.flatMap((outcome) => outcome.notices);
};

const syncWithBaseline = async (input: SyncInput, baselinePath: string) => {
  try {
    return await syncIn(input, baselinePath);
  } catch (error) {
    await rm(baselinePath, { force: true });

    throw error;
  }
};

const syncVolume = async (input: SyncInput): Promise<SyncResult> => {
  const baselinePath = stateLayout(input.stateDir).repo(input.repoHash).syncBaseline;
  const returned = await writeBack(input, baselinePath);
  const notices = await syncWithBaseline(input, baselinePath).catch((error: unknown) => [
    `warning: the sandbox copies of the agent settings were not refreshed: ${errorMessage(error)}`,
    "warning: preference changes made in the sandbox from now on will not be written back to the host",
  ]);

  return { changes: returned.changes, notices: [...returned.notices, ...notices] };
};

export const syncVolumeFiles = (input: SyncInput): Promise<SyncResult> =>
  withFileLock(stateLayout(input.stateDir).repo(input.repoHash).syncLock, () => syncVolume(input), {
    timeoutMs: LOCK_TIMEOUT_MS,
  });
