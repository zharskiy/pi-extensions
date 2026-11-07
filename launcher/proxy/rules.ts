import type { CredentialRule } from "../config/index.ts";
import { isAuthLikeHeader } from "../shared/index.ts";
import { normalizeHost } from "./policy.ts";

export type HeaderPair = readonly [string, string];

export interface ScrubSecret {
  value: string;
  placeholder?: string;
}

const TLS_PORT = 443;

const SECRET_MARKER = "{secret}";

const REDACTED = "pi-sandbox-redacted";

const FETCH_RESERVED = "sec-";

const pathMatches = (prefix: string | undefined, path: string) =>
  prefix === undefined || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

const prefixLength = (rule: CredentialRule) => rule.pathPrefix?.length ?? 0;

export const isRuleHost = (rules: CredentialRule[], host: string, port: number) =>
  rules.some((rule) => normalizeHost(rule.host) === normalizeHost(host) && (rule.port ?? TLS_PORT) === port);

export const matchRules = (rules: CredentialRule[], host: string, port: number, path: string) =>
  rules
    .filter((rule) => normalizeHost(rule.host) === normalizeHost(host))
    .filter((rule) => (rule.port ?? TLS_PORT) === port)
    .filter((rule) => pathMatches(rule.pathPrefix, path.split("?")[0] ?? "/"))
    .sort((left, right) => prefixLength(right) - prefixLength(left));

const carries = (value: string, placeholder: string | undefined) =>
  placeholder !== undefined && placeholder !== "" && value.includes(placeholder);

const isRuleHeader = (name: string, rule: CredentialRule) =>
  rule.header !== undefined && name.toLowerCase() === rule.header.toLowerCase();

const isCarrier = (name: string, rule: CredentialRule) =>
  rule.header === undefined
    ? isAuthLikeHeader(name) && !name.toLowerCase().startsWith(FETCH_RESERVED)
    : isRuleHeader(name, rule);

export const withoutStrayPlaceholders = (headers: HeaderPair[], rule: CredentialRule) =>
  headers.filter(([name, value]) => isCarrier(name, rule) || !carries(value, rule.placeholder));

export const ruleApplies = (headers: HeaderPair[], rule: CredentialRule) => {
  const placeholderSent = headers.some(
    ([name, value]) => isCarrier(name, rule) && carries(value, rule.placeholder),
  );
  const headerMissing = rule.header !== undefined && !headers.some(([name]) => isRuleHeader(name, rule));

  return placeholderSent || headerMissing;
};

const substitute = (headers: HeaderPair[], rule: CredentialRule, secret: string) =>
  headers.map(
    ([name, value]): HeaderPair =>
      isCarrier(name, rule) && carries(value, rule.placeholder)
        ? [name, value.replaceAll(rule.placeholder ?? "", secret)]
        : [name, value],
  );

const templated = (rule: CredentialRule, secret: string) =>
  (rule.template ?? SECRET_MARKER).replaceAll(SECRET_MARKER, secret);

const setRuleHeader = (headers: HeaderPair[], rule: CredentialRule, secret: string) => {
  const header = rule.header;

  if (header === undefined) {
    return headers;
  }

  const present = headers.filter(([name]) => isRuleHeader(name, rule));
  const replace = present.length === 0 || present.some(([, value]) => carries(value, rule.placeholder));

  if (!replace) {
    return headers;
  }

  return [
    ...headers.filter(([name]) => !isRuleHeader(name, rule)),
    [header, templated(rule, secret)] as const,
  ];
};

const strip = (headers: HeaderPair[], rule: CredentialRule) =>
  headers.filter(([name, value]) => !(isCarrier(name, rule) && carries(value, rule.placeholder)));

export const rewriteRequestHeaders = (
  headers: HeaderPair[],
  rule: CredentialRule,
  secret: string | undefined,
): HeaderPair[] => {
  const kept = withoutStrayPlaceholders(headers, rule);

  if (secret === undefined) {
    return strip(kept, rule);
  }

  return setRuleHeader(substitute(kept, rule, secret), rule, secret);
};

const userinfoBase64 = (secret: string) => {
  try {
    const url = new URL(secret);

    return url.username === ""
      ? undefined
      : Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
          "base64",
        );
  } catch {
    return undefined;
  }
};

export const transformSecret = (rule: CredentialRule, secret: string) =>
  rule.transform === "urlUserinfoBase64" ? userinfoBase64(secret) : secret;

const scrubValue = (value: string, secrets: ScrubSecret[]) =>
  secrets
    .filter((secret) => secret.value !== "")
    .reduce((text, secret) => text.replaceAll(secret.value, secret.placeholder ?? REDACTED), value);

export const scrubResponseHeaders = (headers: HeaderPair[], secrets: ScrubSecret[]): HeaderPair[] =>
  headers.map(([name, value]): HeaderPair => [name, scrubValue(value, secrets)]);
