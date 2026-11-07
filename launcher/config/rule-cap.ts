import type { CredentialRule, EffectiveConfig, LayerConfig, LayerName } from "./types.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const TLS_PORT = 443;

const ENTRY_PORT = /^(.+):(\d{1,5})$/;

const normalized = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

const matchesHost = (host: string, pattern: string) => {
  if (!pattern.startsWith("*.")) {
    return host === pattern;
  }

  const suffix = pattern.slice(1);
  const label = host.slice(0, -suffix.length);

  return host.endsWith(suffix) && label.length > 0 && !label.includes(".");
};

const matchesEntry = (entry: string, rule: CredentialRule) => {
  const withPort = ENTRY_PORT.exec(entry.trim());
  const pattern = normalized(withPort?.[1] ?? entry);
  const port = withPort?.[2] === undefined ? TLS_PORT : Number(withPort[2]);

  return matchesHost(normalized(rule.host), pattern) && port === (rule.port ?? TLS_PORT);
};

const policyRuleIds = (layers: Layers) =>
  new Set((layers.policy?.credentials?.rules ?? []).map((rule) => rule.id));

const authority = (rule: CredentialRule) =>
  rule.port === undefined || rule.port === TLS_PORT ? rule.host : `${rule.host}:${rule.port}`;

export const capManualRules = (effective: EffectiveConfig, layers: Layers) => {
  const cap = effective.egressCap.derivedHosts;

  if (cap === undefined) {
    return { effective, notices: [] };
  }

  const exempt = policyRuleIds(layers);
  const rules = effective.config.credentials.rules;
  const kept = rules.filter((rule) => exempt.has(rule.id) || cap.some((entry) => matchesEntry(entry, rule)));
  const dropped = rules.filter((rule) => !kept.includes(rule));

  return {
    effective: {
      ...effective,
      config: { ...effective.config, credentials: { ...effective.config.credentials, rules: kept } },
    },
    notices: dropped.map(
      (rule) =>
        `credentials.rules ${rule.id}: ${authority(rule)} is outside the egress.allow of the policy or org baseline, so the rule was dropped`,
    ),
  };
};
