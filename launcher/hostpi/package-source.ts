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

const URL_IN_SOURCE = /^((?:git:)?)([a-z][a-z0-9+.-]*:\/\/.*)$/i;

const WEB_PROTOCOLS = new Set(["http:", "https:"]);

const parsedUrl = (text: string) => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

const carriesCredential = (url: URL) =>
  url.password !== "" || (url.username !== "" && WEB_PROTOCOLS.has(url.protocol));

export const withoutSourceCredential = (source: string) => {
  const match = URL_IN_SOURCE.exec(source);
  const url = match === null ? undefined : parsedUrl(match[2] ?? "");

  if (match === null || url === undefined || !carriesCredential(url)) {
    return undefined;
  }

  const host = url.host;

  url.username = "";

  url.password = "";

  return { source: `${match[1] ?? ""}${url.href}`, host };
};
