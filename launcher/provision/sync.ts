import { stateLayout, withFileLock } from "../shared/index.ts";
import { prepareHostSettings, sandboxSettings } from "./merge-settings.ts";
import type { SyncInput, SyncResult } from "./types.ts";
import { writeVolumeFile } from "./volume.ts";

const LOCK_TIMEOUT_MS = 30_000;

const FILE = "settings.json";

const syncSettings = async (input: SyncInput): Promise<SyncResult> => {
  const prepared = prepareHostSettings(input.hostSettings ?? {}, {
    hostAgentDir: input.hostAgentDir,
    mountRoots: [input.repoRoot],
  });

  await writeVolumeFile(input.backend, input.containerId, FILE, sandboxSettings(prepared.settings));

  return { notices: prepared.notices };
};

export const syncSettingsFile = (input: SyncInput): Promise<SyncResult> =>
  withFileLock(stateLayout(input.stateDir).repo(input.repoHash).syncLock, () => syncSettings(input), {
    timeoutMs: LOCK_TIMEOUT_MS,
  });
