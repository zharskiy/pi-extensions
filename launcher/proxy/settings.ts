import type {
  CredentialRule,
  CredentialSource,
  EgressCap,
  ExtraCa,
  GrantsConfig,
  ParentProxy,
  SandboxConfig,
} from "../config/index.ts";
import { authorityOf, TLS_PORT } from "../config/index.ts";
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
  rules: CredentialRule[];
  privateHosts: string[];
  parentProxy: ParentProxy;
  grants: GrantsConfig;
  extraCa: ExtraCa[];
  cap: EgressCap;
}

const SETTINGS_VERSION = 2;

const gatewaySettings = (config: SandboxConfig): GatewaySettings | undefined => {
  if (config.gateway === undefined) {
    return undefined;
  }

  const url = new URL(config.gateway.url);

  return {
    host: url.hostname.toLowerCase(),
    port: Number(url.port || TLS_PORT),
    url: config.gateway.url,
    authHeader: config.gateway.authHeader,
    placeholder: config.gateway.placeholder,
    providers: config.gateway.providers.map((provider) => provider.id),
  };
};

const legacyCredentials = (credentials: SandboxConfig["credentials"]): CredentialSource => {
  if (credentials.kind === "static") {
    return { kind: "static", envVar: credentials.envVar, keychainService: credentials.keychainService };
  }

  if (credentials.kind === "sso") {
    return { kind: "sso", command: credentials.command };
  }

  return { kind: "host-pi-auth", authFile: credentials.authFile };
};

const ruleHost = (rule: CredentialRule) => authorityOf(rule.host, rule.port ?? TLS_PORT);

const sorted = (values: string[]) => [...values].sort();

export const proxySettings = (config: SandboxConfig, cap: EgressCap = {}): ProxySettings => {
  const gateway = gatewaySettings(config);
  const rules = config.credentials.rules ?? [];

  return {
    policy: {
      allow: sorted(config.egress.allow),
      mcpHosts: sorted(config.egress.mcpHosts),
      deny: sorted(config.egress.deny ?? []),
      credentialHosts: sorted([...new Set(rules.map(ruleHost))]),
      ...(gateway === undefined ? {} : { gatewayHost: gateway.host, gatewayPort: gateway.port }),
      ...(cap.grants === undefined ? {} : { grantCap: sorted(cap.grants) }),
    },
    ...(gateway === undefined ? {} : { gateway }),
    credentials: legacyCredentials(config.credentials),
    rules,
    privateHosts: sorted(config.egress.privateHosts ?? []),
    parentProxy: config.egress.parentProxy ?? "env",
    grants: config.egress.grants,
    extraCa: config.tls?.extraCa ?? [],
    cap: {
      ...(cap.derivedHosts === undefined ? {} : { derivedHosts: sorted(cap.derivedHosts) }),
      ...(cap.grants === undefined ? {} : { grants: sorted(cap.grants) }),
    },
  };
};

export const proxyPolicyHash = (config: SandboxConfig, cap: EgressCap = {}) =>
  sha256Hex(JSON.stringify({ version: SETTINGS_VERSION, ...proxySettings(config, cap) }));
