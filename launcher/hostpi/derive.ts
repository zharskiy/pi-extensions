import { type CredentialRule, type DeriveConfig, matchesPattern, normalizeHost } from "../config/index.ts";
import { deriveAuth } from "./derive-auth.ts";
import { deriveMcp } from "./derive-mcp.ts";
import { deriveModels } from "./derive-models.ts";
import { endpointKey } from "./endpoints.ts";
import { gatewayFiles } from "./gateway.ts";
import { objectOr } from "./json.ts";
import type { DerivedSandboxPi, DeriveInput, JsonObject } from "./types.ts";

const without = (object: JsonObject, keys: string[]) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

const allowedByDerive = (derive: DeriveConfig, host: string) =>
  derive.enabled &&
  (derive.hosts === undefined ||
    derive.hosts.some((pattern) => matchesPattern(normalizeHost(host), normalizeHost(pattern))));

const keptDerived = (derived: CredentialRule[], manual: CredentialRule[], derive: DeriveConfig) => {
  const manualHosts = new Set(manual.map((rule) => rule.host.toLowerCase()));

  return derived.filter((rule) => !manualHosts.has(rule.host) && allowedByDerive(derive, rule.host));
};

export const deriveSandboxPi = (input: DeriveInput): DerivedSandboxPi => {
  const context = { salt: input.salt, agentDir: input.files.agentDir };
  const gateway = gatewayFiles(input);
  const gatewayIds = Object.keys(gateway.providers);
  const models = objectOr(input.files.models);
  const providers = without(objectOr(models.providers), gatewayIds);
  const auth = deriveAuth(context, {
    auth: without(objectOr(input.files.auth), gatewayIds),
    modelsProviders: providers,
    providerHosts: input.providerHosts,
    env: input.env,
  });
  const modelsSection = deriveModels(context, { ...models, providers }, input.providerHosts);
  const mcp = deriveMcp(context, objectOr(input.files.mcp), {
    signedIn: input.mcpSignedIn,
    vault: input.vault,
  });
  const manual = gateway.rule === undefined ? input.manual : [...input.manual, gateway.rule];
  const derived = keptDerived([...auth.rules, ...modelsSection.rules, ...mcp.rules], manual, input.derive);
  const notices = [...(input.files.notices ?? []), ...auth.notices, ...modelsSection.notices, ...mcp.notices];

  return {
    rules: [...derived, ...manual],
    hosts: [...new Set(derived.map(endpointKey))],
    files: {
      "auth.json": { ...auth.value, ...gateway.auth },
      "models.json": {
        ...modelsSection.value,
        providers: { ...objectOr(modelsSection.value.providers), ...gateway.providers },
      },
      "mcp.json": mcp.value,
    },
    notices: [...new Set(notices)],
    vault: mcp.vault,
  };
};
