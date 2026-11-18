import { isIP } from "node:net";

export const TLS_PORT = 443;

const PLAIN_HTTP_PORT = 80;

const MAX_PORT = 65_535;

const MAX_NAME_LENGTH = 253;

const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;

const WRITTEN_PORT = /^(.*):([0-9]+)$/;

const DECIMAL_PORT = /^[1-9][0-9]{0,4}$/;

const WILDCARD = "*.";

export const SECRET_MARKER = "{secret}";

export const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

export const parseEntry = (entry: string) => {
  const withPort = WRITTEN_PORT.exec(entry.trim());

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

export const matchesDenyEntry = (host: string, pattern: string) => {
  const domain = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  const below = host.endsWith(`.${domain}`);

  return pattern.startsWith("*.") ? below : host === domain || below;
};

export const authorityOf = (host: string, port: number) => (port === TLS_PORT ? host : `${host}:${port}`);

export const isLoopbackName = (host: string) => host === "localhost" || host.endsWith(".localhost");

export const isHostName = (host: string) =>
  host.length <= MAX_NAME_LENGTH && host.split(".").every((label) => LABEL.test(label));

export const isNumericName = (host: string) => NUMERIC_LABEL.test(host.split(".").at(-1) ?? "");

interface EntryShape {
  wildcard: boolean;
  port: boolean;
}

export type HostEntry = { pattern: string; port: number | undefined } | { problem: string };

const shapeText = (shape: EntryShape) => {
  if (shape.port) {
    return "must be a host name or host:port";
  }

  return shape.wildcard ? "must be a host name or *.domain" : "must be a host name";
};

const portProblem = (text: string) => {
  if (!DECIMAL_PORT.test(text) || Number(text) > MAX_PORT) {
    return `has a port that is not a number from 1 to ${MAX_PORT}`;
  }

  return Number(text) === PLAIN_HTTP_PORT ? "names port 80, and plain HTTP is never forwarded" : undefined;
};

const nameProblem = (name: string, shape: EntryShape) => {
  if (!isHostName(name)) {
    return shapeText(shape);
  }

  if (isNumericName(name)) {
    return "must not be an IP address";
  }

  return isLoopbackName(name) ? "must not name loopback" : undefined;
};

export const parseHostEntry = (text: string, shape: EntryShape): HostEntry => {
  const lower = text.toLowerCase();

  if (isIP(lower.replace(/^\[|\]$/g, "")) !== 0) {
    return { problem: "must not be an IP address" };
  }

  const written = shape.port ? WRITTEN_PORT.exec(lower) : null;
  const host = written === null ? lower : (written[1] ?? "");
  const port = written === null ? undefined : portProblem(written[2] ?? "");
  const wildcard = shape.wildcard && host.startsWith(WILDCARD);
  const problem = port ?? nameProblem(wildcard ? host.slice(WILDCARD.length) : host, shape);

  if (problem !== undefined) {
    return { problem };
  }

  return { pattern: host, port: written === null ? undefined : Number(written[2]) };
};

export const fillTemplate = (template: string | undefined, secret: string) =>
  (template ?? SECRET_MARKER).replaceAll(SECRET_MARKER, secret);
