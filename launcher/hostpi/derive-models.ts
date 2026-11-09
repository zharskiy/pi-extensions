import { join } from "node:path";
import type { SecretRef } from "../config/index.ts";
import { isJsonObject } from "../shared/index.ts";
import { type Endpoint, endpointOf, strippedUrl } from "./endpoints.ts";
import { deriveHeaders, type HeaderTarget } from "./headers.ts";
import { jsonPointer, objectOr } from "./json.ts";
import { noHostNotice, providerEndpoints } from "./provider-endpoints.ts";
import { type DeriveContext, mergeSections, placeholderOf, rulesFor, type Section } from "./rules.ts";
import type { JsonObject, ProviderHosts } from "./types.ts";

interface ProviderScope {
  context: DeriveContext;
  id: string;
  file: string;
  endpoints: Endpoint[];
}

const withHeaders = (
  scope: ProviderScope,
  object: JsonObject,
  target: Omit<HeaderTarget, "label" | "file">,
): Section<JsonObject> => {
  if (object.headers === undefined) {
    return { value: object, rules: [], notices: [] };
  }

  const section = deriveHeaders(
    scope.context,
    { ...target, label: `models ${scope.id}`, file: scope.file },
    object.headers,
  );
  const { headers: _dropped, ...rest } = object;

  return {
    value: section.value === undefined ? rest : { ...rest, headers: section.value },
    rules: section.rules,
    notices: section.notices,
  };
};

const modelSecret = (scope: ProviderScope, id: string, name: string): SecretRef => ({
  file: scope.file,
  format: "json",
  key: jsonPointer(["providers", scope.id, "models", `[id=${id}]`, "headers", name]),
});

const modelEndpoints = (scope: ProviderScope, model: JsonObject) => {
  if (model.baseUrl === undefined) {
    return scope.endpoints;
  }

  const result = endpointOf(model.baseUrl);

  return "endpoint" in result ? [result.endpoint] : [];
};

const modelSection = (scope: ProviderScope, model: unknown, index: number): Section<unknown> => {
  if (!isJsonObject(model)) {
    return { value: model, rules: [], notices: [] };
  }

  const ownId = typeof model.id === "string" ? model.id : undefined;
  const modelId = ownId ?? String(index);
  const stripped = strippedUrl(
    `models ${scope.id}`,
    `providers.${scope.id}.models[${index}].baseUrl`,
    model.baseUrl,
  );
  const headed = withHeaders(scope, model, {
    identity: `models:${scope.id}:model:${modelId}`,
    pointer: ["providers", scope.id, "models", index, "headers"],
    endpoints: modelEndpoints(scope, model),
    ...(ownId === undefined ? {} : { literalSecret: (name: string) => modelSecret(scope, ownId, name) }),
  });
  const value = model.baseUrl === undefined ? headed.value : { ...headed.value, baseUrl: stripped.value };

  return {
    value,
    rules: headed.rules,
    notices: [...stripped.notices, ...headed.notices],
  };
};

const overrideSection = (
  scope: ProviderScope,
  modelId: string,
  override: unknown,
): Section<[string, unknown]> => {
  if (!isJsonObject(override)) {
    return { value: [modelId, override], rules: [], notices: [] };
  }

  const section = withHeaders(scope, override, {
    identity: `models:${scope.id}:override:${modelId}`,
    pointer: ["providers", scope.id, "modelOverrides", modelId, "headers"],
    endpoints: scope.endpoints,
  });

  return { ...section, value: [modelId, section.value] };
};

const localNotices = (id: string, provider: JsonObject) => {
  const models = Array.isArray(provider.models) ? provider.models.filter(isJsonObject) : [];
  const local = [provider.baseUrl, ...models.map((model) => model.baseUrl)]
    .filter((url) => url !== undefined)
    .map(endpointOf)
    .flatMap((result) => ("local" in result ? [result.local] : []));

  return [...new Set(local)].map(
    (host) => `models ${id}: ${host} is a host-local or plain-http endpoint, not reachable from the sandbox`,
  );
};

const apiKeySection = (scope: ProviderScope, provider: JsonObject): Section<JsonObject> => {
  if (typeof provider.apiKey !== "string") {
    return { value: provider, rules: [], notices: [] };
  }

  const identity = `models:${scope.id}:apiKey`;
  const placeholder = placeholderOf(scope.context, identity);

  return {
    value: { ...provider, apiKey: placeholder },
    rules: rulesFor(identity, scope.endpoints, { placeholder, secret: { piAuth: scope.id } }),
    notices: [],
  };
};

const needsHost = (provider: JsonObject) =>
  typeof provider.apiKey === "string" || provider.headers !== undefined;

const providerSection = (scope: ProviderScope, provider: JsonObject): Section<[string, unknown]> => {
  const keyed = apiKeySection(scope, provider);
  const headed = withHeaders(scope, keyed.value, {
    identity: `models:${scope.id}`,
    pointer: ["providers", scope.id, "headers"],
    endpoints: scope.endpoints,
  });
  const models = Array.isArray(provider.models)
    ? mergeSections(provider.models.map((model, index) => modelSection(scope, model, index)))
    : undefined;
  const overrides = isJsonObject(provider.modelOverrides)
    ? mergeSections(
        Object.entries(provider.modelOverrides).map(([modelId, value]) =>
          overrideSection(scope, modelId, value),
        ),
      )
    : undefined;
  const stripped = strippedUrl(`models ${scope.id}`, `providers.${scope.id}.baseUrl`, provider.baseUrl);
  const rendered = {
    ...headed.value,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: stripped.value }),
    ...(models === undefined ? {} : { models: models.values }),
    ...(overrides === undefined ? {} : { modelOverrides: Object.fromEntries(overrides.values) }),
  };
  const hostless =
    scope.endpoints.length === 0 && needsHost(provider) ? [noHostNotice(`models ${scope.id}`)] : [];

  return {
    value: [scope.id, rendered],
    rules: [...keyed.rules, ...headed.rules, ...(models?.rules ?? []), ...(overrides?.rules ?? [])],
    notices: [
      ...stripped.notices,
      ...localNotices(scope.id, provider),
      ...hostless,
      ...headed.notices,
      ...(models?.notices ?? []),
      ...(overrides?.notices ?? []),
    ],
  };
};

export const deriveModels = (
  context: DeriveContext,
  models: JsonObject,
  providerHosts: ProviderHosts,
): Section<JsonObject> => {
  const providers = objectOr(models.providers);
  const file = join(context.agentDir, "models.json");
  const merged = mergeSections(
    Object.entries(providers).map(([id, provider]): Section<[string, unknown]> => {
      if (!isJsonObject(provider)) {
        return { value: [id, provider], rules: [], notices: [] };
      }

      const endpoints = providerEndpoints(id, providers, providerHosts);

      return providerSection({ context, id, file, endpoints }, provider);
    }),
  );

  return {
    value: { ...models, providers: Object.fromEntries(merged.values) },
    rules: merged.rules,
    notices: merged.notices,
  };
};
