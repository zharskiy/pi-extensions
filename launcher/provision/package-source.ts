import { isJsonObject } from "../shared/index.ts";

export const sourceOfEntry = (entry: unknown) => {
  if (typeof entry === "string") {
    return entry;
  }

  return isJsonObject(entry) && typeof entry.source === "string" ? entry.source : undefined;
};

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

export const credentialHosts = (packages: unknown) =>
  (Array.isArray(packages) ? packages : []).flatMap((entry) => {
    const source = sourceOfEntry(entry);
    const stripped = source === undefined ? undefined : withoutSourceCredential(source);

    return stripped === undefined ? [] : [stripped.host];
  });
