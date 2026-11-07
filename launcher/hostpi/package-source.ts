import { isJsonObject } from "./json.ts";
import type { JsonObject } from "./types.ts";

const NPM_SOURCE = /^npm:(@[^/@]+\/[^@]+|[^@]+)(?:@.*)?$/;

export const packageSourceKey = (source: string) => {
  const npm = NPM_SOURCE.exec(source);

  return npm === null ? source : `npm:${npm[1]}`;
};

export const sourceOfEntry = (entry: unknown) => {
  if (typeof entry === "string") {
    return entry;
  }

  return isJsonObject(entry) && typeof entry.source === "string" ? entry.source : undefined;
};

export const entryMatches = (source: string) => (entry: unknown) => {
  const own = sourceOfEntry(entry);

  return own !== undefined && packageSourceKey(own) === packageSourceKey(source);
};

export const packagesOf = (settings: JsonObject | undefined): unknown[] =>
  Array.isArray(settings?.packages) ? settings.packages : [];
