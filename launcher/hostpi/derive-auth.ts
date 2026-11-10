import { isJsonObject, isSecretName, jwtShapedPlaceholder } from "../shared/index.ts";
import { noHostNotice, providerEndpoints } from "./provider-endpoints.ts";
import {
  type DeriveContext,
  mergeSections,
  noticeOnly,
  placeholderOf,
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

const FAR_FUTURE_EXPIRES = 4102444800000;

const OAUTH_SECRET_FIELDS = new Set(["access", "refresh", "expires"]);

type Entry = [string, JsonObject];

const isPrimitive = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const withRules = (
  sources: AuthSources,
  id: string,
  entry: Entry,
  rules: Parameters<typeof rulesFor>[2],
  identity: string,
): Section<Entry[]> => {
  const endpoints = providerEndpoints(id, sources.modelsProviders, sources.providerHosts);

  return {
    value: [entry],
    rules: rulesFor(identity, endpoints, rules),
    notices: endpoints.length === 0 ? [noHostNotice(`auth ${id}`)] : [],
  };
};

const apiKeyEntry = (context: DeriveContext, sources: AuthSources, id: string): Section<Entry[]> => {
  const identity = `auth:${id}:key`;
  const placeholder = placeholderOf(context, identity);

  return withRules(
    sources,
    id,
    [id, { type: "api_key", key: placeholder }],
    { placeholder, secret: { piAuth: id } },
    identity,
  );
};

const oauthEntry = (
  context: DeriveContext,
  sources: AuthSources,
  id: string,
  entry: JsonObject,
): Section<Entry[]> => {
  const identity = `auth:${id}:access`;
  const access = typeof entry.access === "string" ? entry.access : "";
  const placeholder = jwtShapedPlaceholder(access, context.salt, identity);
  const kept = Object.entries(entry).filter(
    ([key, value]) => isPrimitive(value) && !OAUTH_SECRET_FIELDS.has(key) && !isSecretName(key),
  );
  const rendered = {
    ...Object.fromEntries(kept),
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
): Section<Entry[]> => {
  const type = isJsonObject(entry) ? entry.type : undefined;

  if (type === "api_key") {
    return apiKeyEntry(context, sources, id);
  }

  if (type === "oauth" && isJsonObject(entry)) {
    return oauthEntry(context, sources, id, entry);
  }

  return noticeOnly([], `auth ${id}: unsupported entry type, not copied`);
};

const hasEnvKey = (sources: AuthSources, envVars: string[] | undefined) =>
  (envVars ?? []).some((name) => (sources.env[name] ?? "") !== "");

const envProviderIds = (sources: AuthSources) =>
  Object.entries(sources.providerHosts)
    .filter(([id, entry]) => sources.auth[id] === undefined && hasEnvKey(sources, entry.envVars))
    .map(([id]) => id);

export const deriveAuth = (context: DeriveContext, sources: AuthSources): Section<JsonObject> => {
  const merged = mergeSections([
    ...Object.entries(sources.auth).map(([id, entry]) => hostEntry(context, sources, id, entry)),
    ...envProviderIds(sources).map((id) => apiKeyEntry(context, sources, id)),
  ]);

  return { value: Object.fromEntries(merged.values.flat()), rules: merged.rules, notices: merged.notices };
};
