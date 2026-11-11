import {
  type CredentialRule,
  type DeriveConfig,
  matchesPattern,
  normalizeHost,
  parseEntry,
  TLS_PORT,
} from "../config/index.ts";
import { deriveAuth } from "./derive-auth.ts";
import { deriveMcp } from "./derive-mcp.ts";
import { baseUrlEndpointKeys, deriveModels } from "./derive-models.ts";
import { type Endpoint, endpointKey } from "./endpoints.ts";
import { objectOr } from "./json.ts";
import { type DerivedSandboxPi, type DeriveInput, emptyTools, type ToolRegistry } from "./types.ts";

const allowedByDerive = (derive: DeriveConfig, host: string) =>
  derive.enabled &&
  (derive.hosts === undefined ||
    derive.hosts.some((pattern) => matchesPattern(normalizeHost(host), normalizeHost(pattern))));

const keptDerived = (derived: CredentialRule[], manual: CredentialRule[], derive: DeriveConfig) => {
  const manualHosts = new Set(manual.map((rule) => rule.host.toLowerCase()));

  return derived.filter((rule) => !manualHosts.has(rule.host) && allowedByDerive(derive, rule.host));
};

const allowedBy = (endpoint: Endpoint, entries: string[]) =>
  entries.some((entry) => {
    const { pattern, port } = parseEntry(entry);

    return (port ?? TLS_PORT) === (endpoint.port ?? TLS_PORT) && matchesPattern(endpoint.host, pattern);
  });

const registryNotices = (
  registries: ToolRegistry[],
  rules: CredentialRule[],
  egress: string[] | undefined,
) => {
  if (egress === undefined) {
    return [];
  }

  const ruleHosts = new Set(rules.map((rule) => rule.host.toLowerCase()));

  return registries
    .filter(({ endpoint }) => !ruleHosts.has(endpoint.host) && !allowedBy(endpoint, egress))
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
  const tools = input.tools ?? { value: emptyTools(), rules: [], notices: [], registries: [] };
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

  const hosts = [...new Set(derived.map(endpointKey))];
  const baseUrlHosts = baseUrlEndpointKeys(providers);

  return {
    rules: [...derived, ...manual],
    hosts,
    privateHosts: hosts.filter((host) => baseUrlHosts.has(host)),
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
