import type { GatewayConfig, GatewayProvider } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";

interface PiProvider {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: never[];
}

export interface ModelsJson {
  providers: Record<string, PiProvider>;
}

export type AuthJson = Record<string, { type: "api_key"; key: string }>;

const PLACEHOLDER_PREFIX = "pi-sandbox-";

const placeholderOf = (gateway: GatewayConfig) => {
  if (!gateway.placeholder.startsWith(PLACEHOLDER_PREFIX)) {
    throw new LauncherError(
      `gateway.placeholder must start with ${PLACEHOLDER_PREFIX}, the only key the launcher writes into pi's auth.json and models.json`,
      "pick a placeholder such as pi-sandbox-placeholder and keep the real credential on the host",
    );
  }

  return gateway.placeholder;
};

const baseUrlOf = (gateway: GatewayConfig, provider: GatewayProvider & { baseUrl?: string }) =>
  provider.baseUrl ?? `${gateway.url.replace(/\/+$/, "")}/${provider.id}`;

export const renderModelsJson = (gateway: GatewayConfig | undefined): ModelsJson => {
  if (gateway === undefined) {
    return { providers: {} };
  }

  const apiKey = placeholderOf(gateway);

  return {
    providers: Object.fromEntries(
      gateway.providers.map((provider) => [
        provider.id,
        { baseUrl: baseUrlOf(gateway, provider), apiKey, api: provider.apiKind, models: [] },
      ]),
    ),
  };
};

export const renderAuthJson = (gateway: GatewayConfig | undefined): AuthJson => {
  if (gateway === undefined) {
    return {};
  }

  const key = placeholderOf(gateway);

  return Object.fromEntries(
    gateway.providers.map((provider) => [provider.id, { type: "api_key" as const, key }]),
  );
};
