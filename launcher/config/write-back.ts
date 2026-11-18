import { BUILT_IN_WRITE_BACK, type FileKeys, type ValueSpec, type WriteBackTable } from "../shared/index.ts";
import type { ConfigSource, WriteBackConfig } from "./types.ts";

interface WriteBackEntry {
  spec: ValueSpec;
  source: ConfigSource;
}

export type WriteBackListing = Record<string, Record<string, WriteBackEntry>>;

export const builtInKeysOf = (file: string): FileKeys | undefined =>
  Object.hasOwn(BUILT_IN_WRITE_BACK, file) ? BUILT_IN_WRITE_BACK[file] : undefined;

const keptBuiltIns = (file: string, exclude: WriteBackConfig["exclude"]) => {
  const excluded = Object.hasOwn(exclude, file) ? exclude[file] : [];

  return Object.entries(builtInKeysOf(file) ?? {}).filter(([key]) => !excluded.includes(key));
};

const fromConfig = (spec: ValueSpec): WriteBackEntry => ({ spec, source: "config" });

const entriesOf = (config: WriteBackConfig, file: string) => {
  const added = Object.hasOwn(config.add, file) ? config.add[file] : {};
  const builtIns = keptBuiltIns(file, config.exclude).map(([key, spec]): [string, WriteBackEntry] => [
    key,
    Object.hasOwn(added, key) ? fromConfig(added[key]) : { spec, source: "default" },
  ]);
  const extra = Object.entries(added)
    .filter(([key]) => !Object.hasOwn(builtInKeysOf(file) ?? {}, key))
    .map(([key, spec]): [string, WriteBackEntry] => [key, fromConfig(spec)]);

  return [...builtIns, ...extra];
};

const filesOf = (config: WriteBackConfig) => [
  ...new Set([...Object.keys(BUILT_IN_WRITE_BACK), ...Object.keys(config.add)]),
];

export const writeBackListing = (config: WriteBackConfig): WriteBackListing =>
  config.enabled
    ? Object.fromEntries(filesOf(config).map((file) => [file, Object.fromEntries(entriesOf(config, file))]))
    : {};

export const writeBackTableOf = (config: WriteBackConfig): WriteBackTable =>
  Object.fromEntries(
    Object.entries(writeBackListing(config)).map(([file, keys]) => [
      file,
      Object.fromEntries(Object.entries(keys).map(([key, entry]) => [key, entry.spec])),
    ]),
  );
