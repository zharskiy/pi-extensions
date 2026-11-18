import type { Backend } from "../backend/index.ts";
import { readJsonObject, writeJsonFile } from "../shared/index.ts";
import { isVolumeGitDir, type PackagePin } from "./host-packages.ts";
import { removeVolumeDirs } from "./volume.ts";

export interface PackageRefreshInput {
  backend: Backend;
  containerId: string;
  stampPath: string;
  pins: PackagePin[];
  othersLive: () => Promise<boolean>;
  removeTimeoutMs?: number;
}

const PRIVATE_FILE_MODE = 0o600;

const lastPins = async (stampPath: string) => {
  const stamp = await readJsonObject(stampPath);

  return stamp === undefined
    ? undefined
    : new Map(
        Object.entries(stamp).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
};

const DEFERRED_NOTICE =
  "sandbox packages follow the host: git packages refresh at the next launch (another session is running)";

const refreshNotice = (count: number) =>
  `sandbox packages follow the host: reinstalling ${count} ${count === 1 ? "package" : "packages"}`;

const changedSince = (previous: Map<string, string> | undefined) => (pin: PackagePin) => {
  const before = previous?.get(pin.identity);

  return before !== undefined && before !== pin.value;
};

const heldPins = (stale: PackagePin[], previous: Map<string, string> | undefined) =>
  stale.flatMap((pin) => {
    const before = previous?.get(pin.identity);

    return before === undefined ? [] : [[pin.identity, before] as const];
  });

export const refreshPackages = async (input: PackageRefreshInput) => {
  const previous = await lastPins(input.stampPath);
  const stale = input.pins.filter(
    (pin) =>
      pin.guestDir !== undefined && isVolumeGitDir(pin.guestDir) && previous?.get(pin.identity) !== pin.value,
  );
  const deferred = stale.length > 0 && (await input.othersLive());

  if (stale.length > 0 && !deferred) {
    await removeVolumeDirs(
      input.backend,
      input.containerId,
      stale.flatMap((pin) => (pin.guestDir === undefined ? [] : [pin.guestDir])),
      input.removeTimeoutMs,
    );
  }

  const refreshed = deferred ? input.pins.filter((pin) => !stale.includes(pin)) : input.pins;
  const held = deferred ? heldPins(stale, previous) : [];

  await writeJsonFile(
    input.stampPath,
    Object.fromEntries([...held, ...refreshed.map((pin) => [pin.identity, pin.value] as const)]),
    { mode: PRIVATE_FILE_MODE },
  );

  const changed = refreshed.filter(changedSince(previous));
  const notices = changed.length === 0 ? [] : [refreshNotice(changed.length)];

  return deferred ? [...notices, DEFERRED_NOTICE] : notices;
};
