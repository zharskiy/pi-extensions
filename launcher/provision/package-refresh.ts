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

export const refreshPackages = async (input: PackageRefreshInput) => {
  const previous = await lastPins(input.stampPath);
  const staleDirs = input.pins.flatMap((pin) =>
    pin.guestDir !== undefined && isVolumeGitDir(pin.guestDir) && previous?.get(pin.identity) !== pin.value
      ? [pin.guestDir]
      : [],
  );

  if (staleDirs.length > 0 && (await input.othersLive())) {
    return [DEFERRED_NOTICE];
  }

  if (staleDirs.length > 0) {
    await removeVolumeDirs(input.backend, input.containerId, staleDirs);
  }

  await writeJsonFile(
    input.stampPath,
    Object.fromEntries(input.pins.map((pin) => [pin.identity, pin.value])),
    { mode: PRIVATE_FILE_MODE },
  );

  const changed = input.pins.filter((pin) => {
    const before = previous?.get(pin.identity);

    return before !== undefined && before !== pin.value;
  });

  return changed.length === 0 ? [] : [refreshNotice(changed.length)];
};
