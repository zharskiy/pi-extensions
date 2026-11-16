import {
  type CredentialRule,
  type DeriveConfig,
  matchesAllowEntry,
  matchesPattern,
  normalizeHost,
  parseEntry,
  TLS_PORT,
} from "../config/index.ts";
import { deriveAuth } from "./derive-auth.ts";
import { deriveMcp } from "./derive-mcp.ts";
import { deriveModels } from "./derive-models.ts";
import { type Endpoint, endpointKey } from "./endpoints.ts";
import { objectOr } from "./json.ts";
import { type DerivedSandboxPi, type DeriveInput, emptyToolsSection, type Registry } from "./types.ts";

const allowedByDerive = (derive: DeriveConfig, host: string) =>
  derive.enabled &&
  (derive.hosts === undefined ||
    derive.hosts.some((pattern) => matchesPattern(normalizeHost(host), normalizeHost(pattern))));

const keptDerived = (derived: CredentialRule[], manual: CredentialRule[], derive: DeriveConfig) => {
  const manualHosts = new Set(manual.map((rule) => normalizeHost(rule.host)));

  return derived.filter(
    (rule) => !manualHosts.has(normalizeHost(rule.host)) && allowedByDerive(derive, rule.host),
  );
};

const allowedBy = (endpoint: Endpoint, entries: string[]) =>
  entries.some((entry) =>
    matchesAllowEntry(parseEntry(entry), normalizeHost(endpoint.host), endpoint.port ?? TLS_PORT),
  );

const registryNotices = (registries: Registry[], rules: CredentialRule[], egress: string[] | undefined) => {
  if (egress === undefined) {
    return [];
  }

  const ruleHosts = new Set(rules.map((rule) => normalizeHost(rule.host)));

  return registries
    .filter(({ endpoint }) => !ruleHosts.has(normalizeHost(endpoint.host)) && !allowedBy(endpoint, egress))
    .map(
      ({ label, endpoint }) =>
        `${label}: ${endpointKey(endpoint)} has no credential rule and is not in the egress allowlist; add "${endpointKey(endpoint)}" to egress.allow to reach it`,
    );
};

export const deriveSandboxPi = (input: DeriveInput): DerivedSandboxPi => {
  const context = { salt: input.salt, agentDir: input.files.agentDir };
  const models = objectOr(input.files.models);
  const providers = objectOr(models.providers);
  const auth = deriveAuth(context, {
    auth: objectOr(input.files.auth),
    modelsProviders: providers,
    providerHosts: input.providerHosts,
    env: input.env,
  });
  const modelsSection = deriveModels(context, { ...models, providers }, input.providerHosts);
  const mcp = deriveMcp(context, objectOr(input.files.mcp), auth.credentials);
  const manual = input.manual;
  const tools = input.tools ?? emptyToolsSection();
  const derived = keptDerived(
    [...auth.rules, ...modelsSection.rules, ...mcp.rules, ...tools.rules],
    manual,
    input.derive,
  );
  const notices = [
    ...(input.files.notices ?? []),
    ...auth.notices,
    ...modelsSection.notices,
    ...mcp.notices,
    ...tools.notices,
    ...registryNotices(tools.registries, [...derived, ...manual], input.egress),
  ];

  return {
    rules: [...derived, ...manual],
    hosts: [...new Set(derived.map(endpointKey))],
    files: {
      "auth.json": auth.value,
      "models.json": modelsSection.value,
      "mcp.json": mcp.value,
    },
    tools: tools.value,
    oauthServers: derived.flatMap((rule) =>
      "mcpOAuth" in rule.secret ? [{ name: rule.secret.mcpOAuth.server, url: rule.secret.mcpOAuth.url }] : [],
    ),
    notices: [...new Set(notices)],
  };
};
