import type { Backend } from "../backend/index.ts";
import type { JsonObject } from "../hostpi/index.ts";
import { LauncherError } from "../shared/index.ts";
import type { PackageDiff, SyncInput, SyncResult } from "./types.ts";

export const mergeTopLevel = (
  _base: JsonObject | undefined,
  _host: JsonObject,
  _volume: JsonObject | undefined,
): JsonObject => {
  throw new LauncherError("mergeTopLevel is not implemented");
};

export const syncWritableFiles = async (_input: SyncInput): Promise<SyncResult> => {
  throw new LauncherError("syncWritableFiles is not implemented");
};

export const readVolumeSettings = async (
  _backend: Backend,
  _containerId: string,
): Promise<JsonObject | undefined> => {
  throw new LauncherError("readVolumeSettings is not implemented");
};

export const packageChangeFor = (
  _before: JsonObject | undefined,
  _after: JsonObject | undefined,
  _source: string,
): PackageDiff | undefined => {
  throw new LauncherError("packageChangeFor is not implemented");
};
