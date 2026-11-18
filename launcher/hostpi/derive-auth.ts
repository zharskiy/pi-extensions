import type { SecretRef } from "../config/index.ts";
import { isJsonObject, isSecretName, isSecretShapedValue, jwtShapedPlaceholder } from "../shared/index.ts";
import { noHostNotice, providerEndpoints } from "./provider-endpoints.ts";
import {
  type DeriveContext,
  mergeSections,
  noticeOnly,
  placeholderOf,
  type RuleBody,
  rulesFor,
  type Section,
} from "./rules.ts";
import type { JsonObject, ProviderHosts } from "./types.ts";

export interface AuthSources {
  auth: JsonObject;
  modelsProviders: JsonObject;
  providerHosts: ProviderHosts;
  env: Record<string, string | undefined>;
}

export type ProviderCredentials = Record<string, RuleBody>;

export type AuthSection = Section<JsonObject> & { credentials: ProviderCredentials };

const FAR_FUTURE_EXPIRES = 4102444800000;

const OAUTH_SECRET_FIELDS = new Set(["access", "refresh", "expires"]);

type Entry = [string, JsonObject];

type EntrySection = Section<Entry[]> & { credential?: [string, RuleBody] };

const isPrimitive = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const withRules = (
  sources: AuthSources,
  id: string,
  entry: Entry,
  body: RuleBody,
  identity: string,
): EntrySection => {
  const endpoints = providerEndpoints(id, sources.modelsProviders, sources.providerHosts);

  return {
    value: [entry],
    rules: rulesFor(identity, endpoints, body),
    notices: endpoints.length === 0 ? [noHostNotice(`auth ${id}`)] : [],
    credential: [id, body],
  };
};

const envOf = (context: DeriveContext, id: string, env: unknown) => {
  if (!isJsonObject(env)) {
    return {};
  }

  const entries = Object.entries(env).map(([name, value]) => [
    name,
    typeof value === "string" && (isSecretName(name) || isSecretShapedValue(value))
      ? placeholderOf(context, `auth:${id}:env:${name}`)
      : value,
  ]);

  return { env: Object.fromEntries(entries) };
};

const apiKeyEntry = (
  context: DeriveContext,
  sources: AuthSources,
  id: string,
  extra: { env?: unknown; secret?: SecretRef } = {},
): EntrySection => {
  const identity = `auth:${id}:key`;
  const placeholder = placeholderOf(context, identity);

  return withRules(
    sources,
    id,
    [id, { type: "api_key", key: placeholder, ...envOf(context, id, extra.env) }],
    { placeholder, secret: extra.secret ?? { piAuth: id } },
    identity,
  );
};

const oauthEntry = (
  context: DeriveContext,
  sources: AuthSources,
  id: string,
  entry: JsonObject,
): EntrySection => {
  const identity = `auth:${id}:access`;
  const access = typeof entry.access === "string" ? entry.access : "";
  const placeholder = jwtShapedPlaceholder(access, context.salt, identity);
  const kept = Object.entries(entry).filter(
    ([key, value]) => isPrimitive(value) && !OAUTH_SECRET_FIELDS.has(key) && !isSecretName(key),
  );
  const rendered = {
    ...Object.fromEntries(kept),
    ...envOf(context, id, entry.env),
    access: placeholder,
    refresh: placeholderOf(context, `auth:${id}:refresh`),
    expires: FAR_FUTURE_EXPIRES,
  };

  return withRules(
    sources,
    id,
    [id, rendered],
    { placeholder, secret: { piAuth: id, bearer: true } },
    identity,
  );
};

const hostEntry = (
  context: DeriveContext,
  sources: AuthSources,
  id: string,
  entry: unknown,
): EntrySection => {
  const type = isJsonObject(entry) ? entry.type : undefined;

  if (type === "api_key" && isJsonObject(entry)) {
    return apiKeyEntry(context, sources, id, { env: entry.env });
  }

  if (type === "oauth" && isJsonObject(entry)) {
    return oauthEntry(context, sources, id, entry);
  }

  return noticeOnly([], `auth ${id}: unsupported entry type, not copied`);
};

const envKeyOf = (sources: AuthSources, envVars: string[] | undefined) =>
  (envVars ?? []).find((name) => (sources.env[name] ?? "") !== "");

const envProviders = (context: DeriveContext, sources: AuthSources) =>
  Object.entries(sources.providerHosts).flatMap(([id, entry]) => {
    const variable = sources.auth[id] === undefined ? envKeyOf(sources, entry.envVars) : undefined;

    return variable === undefined ? [] : [apiKeyEntry(context, sources, id, { secret: { env: variable } })];
  });

export const deriveAuth = (context: DeriveContext, sources: AuthSources): AuthSection => {
  const sections = [
    ...Object.entries(sources.auth).map(([id, entry]) => hostEntry(context, sources, id, entry)),
    ...envProviders(context, sources),
  ];
  const merged = mergeSections(sections);

  return {
    value: Object.fromEntries(merged.values.flat()),
    rules: merged.rules,
    notices: merged.notices,
    credentials: Object.fromEntries(
      sections.flatMap((section) => (section.credential ? [section.credential] : [])),
    ),
  };
};
