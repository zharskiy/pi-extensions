import type { CredentialRule, ExtraCa, ParentProxy, SandboxConfig } from "../config/index.ts";
import { authorityOf, TLS_PORT } from "../config/index.ts";
import { sha256Hex } from "../shared/index.ts";
import type { EgressPolicy } from "./policy.ts";

export interface ProxySettings {
  policy: EgressPolicy;
  rules: CredentialRule[];
  privateHosts: string[];
  parentProxy: ParentProxy;
  extraCa: ExtraCa[];
}

const ruleHost = (rule: CredentialRule) => authorityOf(rule.host, rule.port ?? TLS_PORT);

const sorted = (values: string[]) => [...values].sort();

export const proxySettings = (config: SandboxConfig): ProxySettings => {
  const rules = config.credentials.rules;

  return {
    policy: {
      allow: sorted(config.egress.allow),
      deny: sorted(config.egress.deny),
      credentialHosts: sorted([...new Set(rules.map(ruleHost))]),
      grants: config.egress.grants,
    },
    rules,
    privateHosts: sorted(config.egress.privateHosts),
    parentProxy: config.egress.parentProxy,
    extraCa: config.tls.extraCa,
  };
};

export const proxyPolicyHash = (config: SandboxConfig) => sha256Hex(JSON.stringify(proxySettings(config)));
