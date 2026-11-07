import {
  type CredentialRule,
  type GatewayConfig,
  LEGACY_GATEWAY_RULE_ID,
  legacyGatewayRule,
} from "../config/index.ts";
import type { DeriveInput, JsonObject } from "./types.ts";

interface GatewayFiles {
  auth: JsonObject;
  providers: JsonObject;
  rule?: CredentialRule;
}

const baseUrlOf = (gateway: GatewayConfig, provider: { id: string; baseUrl?: string }) =>
  provider.baseUrl ?? `${gateway.url.replace(/\/+$/, "")}/${provider.id}`;

const gatewayRuleOf = (input: DeriveInput, gateway: GatewayConfig) =>
  input.manual.some((rule) => rule.id === LEGACY_GATEWAY_RULE_ID)
    ? undefined
    : legacyGatewayRule({ gateway, credentials: input.credentials ?? { kind: "host-pi-auth" } }, input.env);

export const gatewayFiles = (input: DeriveInput): GatewayFiles => {
  const gateway = input.gateway;

  if (gateway === undefined) {
    return { auth: {}, providers: {} };
  }

  const key = gateway.placeholder;

  return {
    auth: Object.fromEntries(gateway.providers.map((provider) => [provider.id, { type: "api_key", key }])),
    providers: Object.fromEntries(
      gateway.providers.map((provider) => [
        provider.id,
        { baseUrl: baseUrlOf(gateway, provider), apiKey: key, api: provider.apiKind, models: [] },
      ]),
    ),
    rule: gatewayRuleOf(input, gateway),
  };
};
