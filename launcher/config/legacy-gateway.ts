import { SECRET_MARKER, TLS_PORT } from "./egress-entry.ts";
import type { CredentialRule, CredentialSource, GatewayConfig, SecretRef } from "./types.ts";

export const LEGACY_GATEWAY_RULE_ID = "gateway";

const keychainCommand = (service: string) => ["security", "find-generic-password", "-s", service, "-w"];

const isSet = (value: string | undefined) => value !== undefined && value !== "";

const staticSecret = (
  source: Extract<CredentialSource, { kind: "static" }>,
  env: Record<string, string | undefined>,
): SecretRef | undefined => {
  if (source.envVar !== undefined && (isSet(env[source.envVar]) || source.keychainService === undefined)) {
    return { env: source.envVar };
  }

  return source.keychainService === undefined
    ? undefined
    : { command: keychainCommand(source.keychainService) };
};

const hostPiAuthSecret = (
  source: Extract<CredentialSource, { kind: "host-pi-auth" }>,
  gateway: GatewayConfig,
): SecretRef | undefined => {
  const provider = gateway.providers[0]?.id;

  if (provider === undefined) {
    return undefined;
  }

  return source.authFile === undefined
    ? { piAuth: provider }
    : { file: source.authFile, pointer: `/${provider.replaceAll("~", "~0").replaceAll("/", "~1")}/key` };
};

const legacySecret = (
  source: CredentialSource,
  gateway: GatewayConfig,
  env: Record<string, string | undefined>,
): SecretRef | undefined => {
  if (source.kind === "static") {
    return staticSecret(source, env);
  }

  if (source.kind === "host-pi-auth") {
    return hostPiAuthSecret(source, gateway);
  }

  return { command: source.command };
};

export const legacyGatewayRule = (
  config: { gateway?: GatewayConfig; credentials: CredentialSource },
  env: Record<string, string | undefined>,
): CredentialRule | undefined => {
  const gateway = config.gateway;
  const secret = gateway === undefined ? undefined : legacySecret(config.credentials, gateway, env);

  if (gateway === undefined || secret === undefined) {
    return undefined;
  }

  const url = new URL(gateway.url);
  const port = Number(url.port || TLS_PORT);

  return {
    id: LEGACY_GATEWAY_RULE_ID,
    host: url.hostname.toLowerCase(),
    ...(port === TLS_PORT ? {} : { port }),
    placeholder: gateway.placeholder,
    header: gateway.authHeader,
    template: SECRET_MARKER,
    secret,
  };
};
