import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../hostpi/index.ts";
import {
  type FileKeys,
  isJsonObject,
  MAX_WRITE_BACK_CHARS,
  parseJsonObject,
  printable,
  SETTINGS_FILE_NAME,
  stableHash,
  type ValueSpec,
  type WriteBackTable,
  withinCeiling,
  writeBackFileProblem,
} from "../shared/index.ts";

type ValueCheck = (value: unknown) => boolean;

export interface SyncedFile {
  name: string;
  keys: readonly string[];
  maxBytes: number;
  checks: Readonly<Record<string, ValueCheck>>;
}

interface KeyChange {
  key: string;
  from: unknown;
  to: unknown;
}

interface FileSides {
  baseline: JsonObject;
  volume: JsonObject;
  host: JsonObject;
}

export type Baseline = Record<string, JsonObject>;

type VolumeParse = { value: JsonObject } | { notices: string[] };

const KIB = 1024;

const EXTENSION_FILE_BYTES = 64 * KIB;

const SETTINGS_FILE_BYTES = 1024 * KIB;

const SHOWN_CHARS = 60;

const THEME_NAME = /^[A-Za-z0-9._-]+$/;

const stringWithin =
  (maxLength = MAX_WRITE_BACK_CHARS) =>
  (value: unknown): value is string =>
    typeof value === "string" && value.length <= Math.min(maxLength, MAX_WRITE_BACK_CHARS);

const isBoundedString = stringWithin();

const isThemeName = (value: unknown) =>
  isBoundedString(value) && THEME_NAME.test(value) && value !== "." && value !== "..";

const inRange = (value: number, spec: { min?: number; max?: number }) =>
  (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max);

const checkOf = (spec: ValueSpec): ValueCheck => {
  if (spec.type === "string") {
    return stringWithin(spec.maxLength);
  }

  if (spec.type === "integer") {
    return (value) => Number.isInteger(value) && inRange(value as number, spec);
  }

  if (spec.type === "number") {
    return (value) => typeof value === "number" && Number.isFinite(value) && inRange(value, spec);
  }

  if (spec.type === "enum") {
    return (value) => (spec.values as readonly unknown[]).includes(value);
  }

  if (spec.type === "stringList") {
    return (value) =>
      Array.isArray(value) &&
      value.every(isBoundedString) &&
      (spec.maxItems === undefined || value.length <= spec.maxItems);
  }

  if (spec.type === "anyOf") {
    const checks = spec.of.map(checkOf);

    return (value) => checks.some((check) => check(value));
  }

  if (spec.type === "boolean") {
    return (value) => typeof value === "boolean";
  }

  if (spec.type === "json") {
    return () => true;
  }

  return spec.type === "fileName" ? isThemeName : () => false;
};

const maxBytesOf = (name: string) =>
  name === SETTINGS_FILE_NAME ? SETTINGS_FILE_BYTES : EXTENSION_FILE_BYTES;

const syncedFileOf = ([name, keys]: [string, FileKeys]): SyncedFile => ({
  name,
  keys: Object.keys(keys),
  maxBytes: maxBytesOf(name),
  checks: Object.fromEntries(Object.entries(keys).map(([key, spec]) => [key, checkOf(spec)])),
});

export const syncedFilesOf = (table: WriteBackTable): SyncedFile[] =>
  Object.entries(withinCeiling(table)).map(syncedFileOf);

export const syncedValues = (file: SyncedFile, value: JsonObject | undefined): JsonObject =>
  value === undefined
    ? {}
    : Object.fromEntries(
        file.keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
      );

const sizeText = (bytes: number) => `${bytes / KIB} KiB`;

export const parseVolumeText = (
  file: Pick<SyncedFile, "name" | "maxBytes">,
  text: string | undefined,
): VolumeParse => {
  if (text === undefined) {
    return { notices: [] };
  }

  if (Buffer.byteLength(text) > file.maxBytes) {
    return {
      notices: [`${file.name} in the sandbox is larger than ${sizeText(file.maxBytes)}; not written back`],
    };
  }

  const value = parseJsonObject(text);

  return value === undefined
    ? { notices: [`${file.name} in the sandbox is not a JSON object; not written back`] }
    : { value };
};

export const allowlistHash = (table: WriteBackTable) => stableHash(withinCeiling(table));

export const parseBaseline = (
  value: unknown,
  synced: readonly SyncedFile[],
  allowlist: string,
): Baseline | undefined => {
  const record = isJsonObject(value) ? value : {};
  const files = record.files;

  if (record.allowlist !== allowlist) {
    return undefined;
  }

  if (!isJsonObject(files) || !synced.every((file) => isJsonObject(files[file.name]))) {
    return undefined;
  }

  return Object.fromEntries(
    synced.map((file) => [file.name, syncedValues(file, files[file.name] as JsonObject)]),
  );
};

export const allowlistChanged = (value: unknown, allowlist: string) =>
  isJsonObject(value) && typeof value.allowlist === "string" && value.allowlist !== allowlist;

const isCopyName = (name: unknown): name is string =>
  typeof name === "string" && name !== SETTINGS_FILE_NAME && writeBackFileProblem(name) === undefined;

export const copiedOf = (value: unknown): string[] => {
  const copied = isJsonObject(value) ? value.copied : undefined;

  return Array.isArray(copied) ? copied.filter(isCopyName) : [];
};

export const baselineRecord = (baseline: Baseline, allowlist: string, copied: readonly string[]) => ({
  allowlist,
  files: baseline,
  copied,
});

const keyValue = (object: JsonObject, key: string) => (Object.hasOwn(object, key) ? object[key] : undefined);

const isAccepted = (file: SyncedFile, key: string, value: unknown) =>
  value === undefined || (file.checks[key]?.(value) ?? true);

export const mergeFile = (file: SyncedFile, sides: FileSides) => {
  const decided = file.keys.map((key) => {
    const baseline = keyValue(sides.baseline, key);
    const volume = keyValue(sides.volume, key);
    const host = keyValue(sides.host, key);

    if (isDeepStrictEqual(volume, baseline) || isDeepStrictEqual(host, volume)) {
      return {};
    }

    if (!isAccepted(file, key, volume)) {
      return { notice: `${file.name}: ${key} in the sandbox is not a valid value; not written back` };
    }

    return isDeepStrictEqual(host, baseline)
      ? { change: { key, from: host, to: volume } }
      : { notice: `${file.name}: ${key} changed on the host and in the sandbox; kept the host value` };
  });

  return {
    changes: decided.flatMap((entry) => (entry.change === undefined ? [] : [entry.change])),
    notices: decided.flatMap((entry) => (entry.notice === undefined ? [] : [entry.notice])),
  };
};

export const applyChanges = (host: JsonObject, changes: readonly KeyChange[]): JsonObject => {
  const removed = new Set(changes.filter((change) => change.to === undefined).map((change) => change.key));
  const kept = Object.fromEntries(Object.entries(host).filter(([key]) => !removed.has(key)));
  const updates = changes
    .filter((change) => change.to !== undefined)
    .map((change) => [change.key, change.to]);

  return { ...kept, ...Object.fromEntries(updates) };
};

const shown = (value: unknown) => {
  if (value === undefined) {
    return "(unset)";
  }

  const text = printable(typeof value === "string" ? value : JSON.stringify(value));

  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS - 1)}…` : text;
};

export const changeLine = (file: SyncedFile, change: KeyChange) =>
  `${file.name} ${change.key}: ${shown(change.from)} → ${shown(change.to)} written to the host`;
