import { authorityOf, matchesEntry, TLS_PORT } from "./egress-entry.ts";
import type { CredentialRule, EffectiveConfig, LayerConfig, LayerName } from "./types.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const ruleMatches = (entry: string, rule: CredentialRule) =>
  matchesEntry(entry, rule.host, rule.port ?? TLS_PORT);

export const grantCapBlocker = (effective: EffectiveConfig, host: string, port: number) =>
  effective.grantCaps?.find((cap) => !cap.allow.some((entry) => matchesEntry(entry, host, port)))?.layer;

const policyRuleIds = (layers: Layers) =>
  new Set((layers.policy?.credentials?.rules ?? []).map((rule) => rule.id));

export const capManualRules = (effective: EffectiveConfig, layers: Layers) => {
  const cap = effective.egressCap.derivedHosts;

  if (cap === undefined) {
    return { effective, notices: [] };
  }

  const exempt = policyRuleIds(layers);
  const rules = effective.config.credentials.rules;
  const kept = rules.filter((rule) => exempt.has(rule.id) || cap.some((entry) => ruleMatches(entry, rule)));
  const dropped = rules.filter((rule) => !kept.includes(rule));

  return {
    effective: {
      ...effective,
      config: { ...effective.config, credentials: { ...effective.config.credentials, rules: kept } },
    },
    notices: dropped.map(
      (rule) =>
        `credentials.rules ${rule.id}: ${authorityOf(rule.host, rule.port ?? TLS_PORT)} is outside the egress.allow of the policy or org baseline, so the rule was dropped`,
    ),
  };
};
