import { looksLikeJwt } from "./placeholder.ts";

const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|JWT)/i;

export const isSecretName = (name: string) => SECRET_NAME.test(name);

const SECRET_WORDS = [
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "apikey",
  "privatekey",
];

const SHORT_SECRET_SEGMENTS = new Set(["pass", "pat", "jwt", "dsn"]);

const isSecretSegment = (segment: string) =>
  SHORT_SECRET_SEGMENTS.has(segment) || SECRET_WORDS.some((word) => segment.endsWith(word));

const QUALIFIERS = new Set([
  "no",
  "max",
  "min",
  "count",
  "limit",
  "size",
  "length",
  "file",
  "dir",
  "path",
  "mode",
  "url",
  "timeout",
  "ttl",
  "type",
  "name",
  "header",
  "env",
  "var",
]);

const segmentsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== "");

export const hasSecretSegment = (name: string) => {
  const segments = segmentsOf(name);
  const first = segments[0] ?? "";
  const last = segments.at(-1) ?? "";

  if (segments.length === 0 || QUALIFIERS.has(first) || QUALIFIERS.has(last)) {
    return false;
  }

  return segments.some(isSecretSegment) || last.endsWith("key");
};

export const isSecretEnvName = (name: string) => isSecretName(name) || hasSecretSegment(name);

export const isAuthLikeHeader = (name: string) => {
  const lower = name.toLowerCase();

  return lower !== "proxy-authorization" && (lower === "authorization" || isSecretName(lower));
};

export const hasUrlUserinfo = (url: unknown) => {
  const parts = typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined;

  return parts !== undefined && (parts.username !== "" || parts.password !== "");
};

const SCHEME_PREFIX = /^(bearer|basic|token)\s+\S/i;

export const isSecretShapedValue = (value: string) =>
  SCHEME_PREFIX.test(value.trim()) || looksLikeJwt(value.trim()) || hasUrlUserinfo(value);

const INERT_WORDS = new Set(["", "true", "false", "yes", "no", "on", "off"]);

export const isInertValue = (value: string) =>
  INERT_WORDS.has(value.trim().toLowerCase()) || /^-?\d+(\.\d+)?$/.test(value.trim());

export const isSecretEnvEntry = (name: string, value: unknown) =>
  typeof value === "string" &&
  (isSecretName(name) ||
    isSecretShapedValue(value) ||
    (!isInertValue(value) && (hasSecretSegment(name) || value.includes("${") || value.startsWith("!"))));
