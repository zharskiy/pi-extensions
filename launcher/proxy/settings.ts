import { authorityOf, type CredentialRule, TLS_PORT } from "../config/index.ts";
import type { RepoProxyInput } from "./files.ts";
import type { EgressPolicy } from "./policy.ts";

const ruleHost = (rule: CredentialRule) => authorityOf(rule.host, rule.port ?? TLS_PORT);

export const proxyPolicy = (input: RepoProxyInput): EgressPolicy => ({
  allow: input.allow,
  deny: input.deny,
  credentialHosts: [...new Set(input.rules.map(ruleHost))],
  grants: input.grants,
});
