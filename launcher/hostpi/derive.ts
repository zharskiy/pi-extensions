import { type CredentialRule, type DeriveConfig, matchesPattern, normalizeHost } from "../config/index.ts";
import { deriveAuth } from "./derive-auth.ts";
import { deriveMcp } from "./derive-mcp.ts";
import { deriveModels } from "./derive-models.ts";
import { endpointKey } from "./endpoints.ts";
import { objectOr } from "./json.ts";
import type { DerivedSandboxPi, DeriveInput } from "./types.ts";

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
  const models = objectOr(input.files.models);
  const providers = objectOr(models.providers);
  const auth = deriveAuth(context, {
    auth: objectOr(input.files.auth),
    modelsProviders: providers,
    providerHosts: input.providerHosts,
    env: input.env,
  });
  const modelsSection = deriveModels(context, { ...models, providers }, input.providerHosts);
  const mcp = deriveMcp(context, objectOr(input.files.mcp), {
    signedIn: input.mcpSignedIn,
    vault: input.vault,
  });
  const manual = input.manual;
  const derived = keptDerived([...auth.rules, ...modelsSection.rules, ...mcp.rules], manual, input.derive);
  const notices = [...(input.files.notices ?? []), ...auth.notices, ...modelsSection.notices, ...mcp.notices];

  return {
    rules: [...derived, ...manual],
    hosts: [...new Set(derived.map(endpointKey))],
    files: {
      "auth.json": auth.value,
      "models.json": modelsSection.value,
      "mcp.json": mcp.value,
    },
    notices: [...new Set(notices)],
    vault: mcp.vault,
  };
};
