import { type CredentialRule, fillTemplate, normalizeHost, TLS_PORT } from "../config/index.ts";
import { isAuthLikeHeader } from "../shared/index.ts";

export type HeaderPair = readonly [string, string];

export interface ScrubSecret {
  value: string;
  placeholder?: string;
}

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
    .filter((rule) => pathMatches(rule.pathPrefix, path))
    .sort((left, right) => prefixLength(right) - prefixLength(left));

const BASIC = /^Basic\s+([A-Za-z0-9+/=]+)$/i;

const basicText = (value: string) => {
  const encoded = BASIC.exec(value)?.[1];

  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("latin1");
};

const viewOf = (value: string) => basicText(value) ?? value;

const carries = (value: string, placeholder: string | undefined) =>
  placeholder !== undefined && placeholder !== "" && viewOf(value).includes(placeholder);

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

export interface RewrittenHeaders {
  headers: HeaderPair[];
  secrets: ScrubSecret[];
}

interface Substituted {
  pair: HeaderPair;
  sent?: ScrubSecret;
}

const latin1 = (text: string) => Buffer.from(text, "utf8").toString("latin1");

const substituteOne = (pair: HeaderPair, rule: CredentialRule, secret: string): Substituted => {
  const [name, value] = pair;
  const placeholder = rule.placeholder ?? "";

  if (!isCarrier(name, rule) || !carries(value, placeholder)) {
    return { pair };
  }

  const decoded = basicText(value);

  if (decoded === undefined) {
    return { pair: [name, value.replaceAll(placeholder, secret)] };
  }

  const encoded = Buffer.from(decoded.replaceAll(placeholder, latin1(secret)), "latin1").toString("base64");

  return { pair: [name, `Basic ${encoded}`], sent: { value: encoded, placeholder: BASIC.exec(value)?.[1] } };
};

const substitute = (headers: HeaderPair[], rule: CredentialRule, secret: string): RewrittenHeaders => {
  const results = headers.map((pair) => substituteOne(pair, rule, secret));

  return {
    headers: results.map((result) => result.pair),
    secrets: results.flatMap((result) => (result.sent === undefined ? [] : [result.sent])),
  };
};

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
    [header, fillTemplate(rule.template, secret)] as const,
  ];
};

const strip = (headers: HeaderPair[], rule: CredentialRule) =>
  headers.filter(([name, value]) => !(isCarrier(name, rule) && carries(value, rule.placeholder)));

export const rewriteRequestHeaders = (
  headers: HeaderPair[],
  rule: CredentialRule,
  secret: string | undefined,
): RewrittenHeaders => {
  const kept = withoutStrayPlaceholders(headers, rule);

  if (secret === undefined) {
    return { headers: strip(kept, rule), secrets: [] };
  }

  const substituted = substitute(kept, rule, secret);

  return { headers: setRuleHeader(substituted.headers, rule, secret), secrets: substituted.secrets };
};

const scrubValue = (value: string, secrets: ScrubSecret[]) =>
  secrets
    .filter((secret) => secret.value !== "")
    .reduce((text, secret) => text.replaceAll(secret.value, secret.placeholder ?? REDACTED), value);

export const scrubResponseHeaders = (headers: HeaderPair[], secrets: ScrubSecret[]): HeaderPair[] =>
  headers.map(([name, value]): HeaderPair => [name, scrubValue(value, secrets)]);
