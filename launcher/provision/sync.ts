import { join } from "node:path";
import { expandHome, stableHash, stateLayout, withFileLock } from "../shared/index.ts";
import { hostWinsSettings, prepareHostSettings } from "./merge-settings.ts";
import type { SyncInput, SyncResult } from "./types.ts";
import { readVolumeFile, writeVolumeFile } from "./volume.ts";

const LOCK_TIMEOUT_MS = 30_000;

const FILE = "settings.json";

const syncSettings = async (input: SyncInput): Promise<SyncResult> => {
  const volume = await readVolumeFile(input.backend, input.containerId, FILE);
  const prepared = prepareHostSettings(input.hostSettings ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.repoRoot, ...input.config.mounts.extraReadOnly.map((path) => expandHome(path))],
  });
  const merged = hostWinsSettings(prepared.settings, volume.value);

  if (volume.value === undefined || stableHash(merged) !== stableHash(volume.value)) {
    await writeVolumeFile(input.backend, input.containerId, FILE, merged);
  }

  return {
    notices: [
      ...prepared.notices,
      ...(volume.invalid
        ? [`${FILE} in the sandbox volume was not valid JSON; replaced with the host copy`]
        : []),
    ],
  };
};

export const syncSettingsFile = (input: SyncInput): Promise<SyncResult> =>
  withFileLock(
    join(stateLayout(input.stateDir).repo(input.repoHash).sync, "sync.lock"),
    () => syncSettings(input),
    {
      timeoutMs: LOCK_TIMEOUT_MS,
    },
  );
