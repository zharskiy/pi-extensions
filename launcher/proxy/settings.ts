import type { CredentialSource, SandboxConfig } from "../config/index.ts";
import { sha256Hex } from "../shared/index.ts";
import type { EgressPolicy } from "./policy.ts";

interface GatewaySettings {
  host: string;
  port: number;
  url: string;
  authHeader: string;
  placeholder: string;
  providers: string[];
}

export interface ProxySettings {
  policy: EgressPolicy;
  gateway?: GatewaySettings;
  credentials: CredentialSource;
}

const SETTINGS_VERSION = 1;

const DEFAULT_TLS_PORT = 443;

const gatewaySettings = (config: SandboxConfig): GatewaySettings | undefined => {
  if (config.gateway === undefined) {
    return undefined;
  }

  const url = new URL(config.gateway.url);

  return {
    host: url.hostname.toLowerCase(),
    port: Number(url.port || DEFAULT_TLS_PORT),
    url: config.gateway.url,
    authHeader: config.gateway.authHeader,
    placeholder: config.gateway.placeholder,
    providers: config.gateway.providers.map((provider) => provider.id),
  };
};

export const proxySettings = (config: SandboxConfig): ProxySettings => {
  const gateway = gatewaySettings(config);

  return {
    policy: {
      allow: [...config.egress.allow].sort(),
      mcpHosts: [...config.egress.mcpHosts].sort(),
      ...(gateway === undefined ? {} : { gatewayHost: gateway.host, gatewayPort: gateway.port }),
    },
    ...(gateway === undefined ? {} : { gateway }),
    credentials: config.credentials,
  };
};

export const proxyPolicyHash = (config: SandboxConfig) =>
  sha256Hex(JSON.stringify({ version: SETTINGS_VERSION, ...proxySettings(config) }));
