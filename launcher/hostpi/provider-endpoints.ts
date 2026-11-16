import { isJsonObject } from "../shared/index.ts";
import { httpsEndpoint, uniqueEndpoints } from "./endpoints.ts";
import { objectOr } from "./json.ts";
import type { JsonObject, ProviderHosts } from "./types.ts";

const modelBaseUrls = (provider: JsonObject) =>
  (Array.isArray(provider.models) ? provider.models : []).filter(isJsonObject).map((model) => model.baseUrl);

export const providerEndpoints = (id: string, modelsProviders: JsonObject, providerHosts: ProviderHosts) => {
  const provider = objectOr(modelsProviders[id]);
  const builtin =
    provider.baseUrl === undefined ? (providerHosts[id]?.hosts ?? []).map((host) => ({ host })) : [];
  const configured = [provider.baseUrl, ...modelBaseUrls(provider)].flatMap(httpsEndpoint);

  return uniqueEndpoints([...configured, ...builtin]);
};

export const noHostNotice = (label: string) =>
  `${label}: no known API host, so no credential rule; add credentials.rules for it`;
