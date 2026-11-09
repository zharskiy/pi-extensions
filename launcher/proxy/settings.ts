import { authorityOf, type CredentialRule, TLS_PORT } from "../config/index.ts";
import type { RepoProxyInput } from "./files.ts";
import type { EgressPolicy } from "./policy.ts";

const ruleHost = (rule: CredentialRule) => authorityOf(rule.host, rule.port ?? TLS_PORT);

const sorted = (values: string[]) => [...values].sort();

export const proxyPolicy = (input: RepoProxyInput): EgressPolicy => ({
  allow: sorted(input.allow),
  deny: sorted(input.deny),
  credentialHosts: sorted([...new Set(input.rules.map(ruleHost))]),
  grants: input.grants,
});
