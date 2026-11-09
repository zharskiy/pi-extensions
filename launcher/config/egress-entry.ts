export const TLS_PORT = 443;

export const SECRET_MARKER = "{secret}";

const ENTRY_PORT = /^(.+):(\d{1,5})$/;

export const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

export const parseEntry = (entry: string) => {
  const withPort = ENTRY_PORT.exec(entry.trim());

  return withPort === null
    ? { pattern: normalizeHost(entry), port: undefined }
    : { pattern: normalizeHost(withPort[1] ?? ""), port: Number(withPort[2]) };
};

export const matchesPattern = (host: string, pattern: string) => {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    const label = host.slice(0, -suffix.length);

    return host.endsWith(suffix) && label.length > 0 && !label.includes(".");
  }

  return host === pattern;
};

export const authorityOf = (host: string, port: number) => (port === TLS_PORT ? host : `${host}:${port}`);

export const isLoopbackName = (host: string) => host === "localhost" || host.endsWith(".localhost");

export const fillTemplate = (template: string | undefined, secret: string) =>
  (template ?? SECRET_MARKER).replaceAll(SECRET_MARKER, secret);
