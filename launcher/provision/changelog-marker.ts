import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject, writeFileAtomic } from "../shared/index.ts";
import { jsonText, readHostFile } from "./host-file.ts";

const SETTINGS = "settings.json";

const MARKERS = "extensionChangelogVersions";

const USER_SCOPE = "user";

const LOCK_ATTEMPTS = 10;

const LOCK_DELAY_MS = 20;

const changelogMarkerKey = (source: string) => JSON.stringify({ source, scope: USER_SCOPE });

const acquire = async (lock: string, attempt = 1): Promise<boolean> => {
  try {
    await mkdir(lock);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= LOCK_ATTEMPTS) {
      return false;
    }

    await delay(LOCK_DELAY_MS);

    return acquire(lock, attempt + 1);
  }
};

const withSettingsLock = async <T>(hostAgentDir: string, action: () => Promise<T>) => {
  const lock = `${join(hostAgentDir, SETTINGS)}.lock`;
  const locked = await acquire(lock);

  try {
    return await action();
  } finally {
    if (locked) {
      await rm(lock, { recursive: true, force: true });
    }
  }
};

const carry = async (hostAgentDir: string, previous: readonly string[], source: string) => {
  const host = await readHostFile(hostAgentDir, SETTINGS);
  const markers = host.value?.[MARKERS];

  if (host.value === undefined || !isJsonObject(markers)) {
    return false;
  }

  const old = previous.filter((entry) => entry !== source).map(changelogMarkerKey);
  const carried = old.map((key) => markers[key]).find((value) => typeof value === "string");

  if (carried === undefined) {
    return false;
  }

  const kept = Object.fromEntries(Object.entries(markers).filter(([key]) => !old.includes(key)));
  const updated = { ...host.value, [MARKERS]: { ...kept, [changelogMarkerKey(source)]: carried } };

  if (isDeepStrictEqual(updated, host.value)) {
    return false;
  }

  await writeFileAtomic(host.path, jsonText(updated), { mode: host.mode });

  return true;
};

export const carryChangelogMarker = (hostAgentDir: string, previous: readonly string[], source: string) =>
  withSettingsLock(hostAgentDir, () => carry(hostAgentDir, previous, source));
