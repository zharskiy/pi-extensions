import { isDeepStrictEqual } from "node:util";
import { expandHome, isJsonObject, isWithin, LauncherError } from "../shared/index.ts";
import { getPath, setPath } from "./dotted.ts";
import type {
  ConfigSource,
  CredentialRule,
  EffectiveConfig,
  EgressCap,
  LayerConfig,
  LayerName,
  ProfileName,
  SandboxConfig,
  WorkspaceRootsConfig,
} from "./types.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

interface MergeInput {
  defaults: SandboxConfig;
  layers: Layers;
  profile?: LayerConfig;
}

interface Rule {
  problem: (above: unknown, below: unknown) => string | undefined;
  lockKey?: string;
  lockers?: readonly ConfigSource[];
  lockedWhenUnset?: boolean;
}

interface Leaf {
  key: string;
  rule?: Rule;
  union?: boolean;
  pick?: (layer: unknown) => unknown;
}

interface State {
  values: Record<string, unknown>;
  sources: Record<string, ConfigSource>;
}

const LAYER_ORDER: readonly LayerName[] = ["policy", "org", "user", "project"];

const CAP_LAYERS: readonly LayerName[] = ["policy", "org"];

const LEGACY_CREDENTIAL_KEYS = ["kind", "envVar", "keychainService", "authFile", "command"];

const unchanged = (above: unknown, below: unknown) =>
  isDeepStrictEqual(above, below) ? undefined : "cannot change";

const unchangedWhenSet = (above: unknown, below: unknown) =>
  above === undefined ? undefined : unchanged(above, below);

const subset = (above: unknown, below: unknown) => {
  const allowed = (above as string[] | undefined) ?? [];
  const added = (below as string[]).filter((entry) => !allowed.includes(entry));

  return added.length === 0 ? undefined : `cannot add ${added.join(", ")}`;
};

const quietSubset = (above: unknown, below: unknown) => {
  const allowed = (above as unknown[] | undefined) ?? [];
  const added = (below as unknown[]).filter(
    (entry) => !allowed.some((item) => isDeepStrictEqual(item, entry)),
  );

  return added.length === 0 ? undefined : "cannot add entries";
};

const ruleSubset = (above: unknown, below: unknown) => {
  const allowed = (above as CredentialRule[] | undefined) ?? [];
  const changed = (below as CredentialRule[]).some(
    (rule) => !allowed.some((item) => item.id === rule.id && isDeepStrictEqual(item, rule)),
  );

  return changed ? "cannot add or change rules, only drop them" : undefined;
};

const cannotEnable = (above: unknown, below: unknown) =>
  above === false && below === true ? "cannot enable" : undefined;

const cannotGrow = (above: unknown, below: unknown) =>
  typeof above === "number" && (below as number) > above ? "cannot grow" : undefined;

const legacyCredentials = (layer: unknown) => {
  const credentials = getPath(layer, "credentials");

  if (!isJsonObject(credentials) || credentials.kind === undefined) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(credentials).filter(([key]) => LEGACY_CREDENTIAL_KEYS.includes(key)),
  );
};

const noFallback = (above: unknown, below: unknown) =>
  above === "refuse" && below === "host" ? "cannot become host" : undefined;

const staysOff = (above: unknown, below: unknown) =>
  above !== true && below === true ? "cannot enable" : undefined;

const narrowerRoots = (above: unknown, below: unknown) => {
  if (above === undefined) {
    return undefined;
  }

  const outer = above as WorkspaceRootsConfig;
  const inner = below as WorkspaceRootsConfig;
  const added = inner.roots.filter(
    (root) => !outer.roots.some((allowed) => isWithin(expandHome(root), expandHome(allowed))),
  );

  if (added.length > 0) {
    return `cannot add ${added.join(", ")}`;
  }

  return outer.outside === "refuse" && inner.outside === "warn" ? "cannot relax outside to warn" : undefined;
};

const LEAVES: readonly Leaf[] = [
  { key: "profile", rule: { problem: unchanged, lockedWhenUnset: true } },
  { key: "backend", rule: { problem: unchanged, lockers: ["policy"] } },
  { key: "fallback", rule: { problem: noFallback } },
  { key: "image.reference", rule: { problem: unchanged, lockKey: "image.digest" } },
  { key: "image.digest", rule: { problem: unchangedWhenSet } },
  { key: "image.packages" },
  { key: "image.npmGlobal" },
  { key: "image.dockerfile" },
  { key: "gateway", rule: { problem: unchanged, lockedWhenUnset: true } },
  { key: "credentials", rule: { problem: unchanged }, pick: legacyCredentials },
  { key: "credentials.rules", rule: { problem: ruleSubset } },
  { key: "credentials.derive.enabled", rule: { problem: cannotEnable } },
  { key: "credentials.derive.hosts", rule: { problem: quietSubset } },
  { key: "credentials.vault.enabled", rule: { problem: cannotEnable } },
  { key: "egress.allow", rule: { problem: subset } },
  { key: "egress.mcpHosts", rule: { problem: subset } },
  { key: "egress.denyPrivateAddresses" },
  { key: "egress.deny", union: true },
  { key: "egress.privateHosts", rule: { problem: quietSubset } },
  { key: "egress.parentProxy", rule: { problem: unchanged } },
  { key: "egress.grants.enabled", rule: { problem: cannotEnable } },
  { key: "egress.grants.maxHours", rule: { problem: cannotGrow } },
  { key: "egress.grants.permanent", rule: { problem: cannotEnable } },
  { key: "tls.extraCa", rule: { problem: quietSubset } },
  { key: "workspaceRoots", rule: { problem: narrowerRoots } },
  { key: "mounts.extraReadOnly", rule: { problem: subset } },
  { key: "mounts.cacheVolumes" },
  { key: "env.allow", union: true },
  { key: "ssh.agent", rule: { problem: staysOff } },
  { key: "resources.cpus" },
  { key: "resources.memoryGiB" },
  { key: "sessions.host", rule: { problem: cannotEnable } },
  { key: "org", rule: { problem: unchanged, lockers: ["policy"] } },
];

const definedLeaves = (layer: unknown) =>
  LEAVES.map((leaf) => ({ leaf, value: (leaf.pick ?? ((from) => getPath(from, leaf.key)))(layer) })).filter(
    ({ value }) => value !== undefined,
  );

const combine = (state: State, leaf: Leaf, value: unknown) => {
  const current = state.values[leaf.key];

  return leaf.union === true && Array.isArray(current)
    ? [...new Set([...current, ...(value as unknown[])])]
    : value;
};

const overlay = (state: State, layer: unknown, source: ConfigSource): State =>
  definedLeaves(layer).reduce<State>(
    (next, { leaf, value }) => ({
      values: { ...next.values, [leaf.key]: combine(next, leaf, value) },
      sources: { ...next.sources, [leaf.key]: source },
    }),
    state,
  );

export const resolveProfileName = (layers: Layers): ProfileName | undefined =>
  layers.policy?.profile ?? layers.org?.profile ?? layers.user?.profile ?? layers.project?.profile;

const withProfile = (lockers: readonly ConfigSource[], chosenAbove: boolean): readonly ConfigSource[] =>
  chosenAbove ? [...lockers, "profile"] : lockers;

const lockersFor = (layer: LayerName, layers: Layers): readonly ConfigSource[] => {
  if (layer === "project") {
    return ["default", "profile", "policy", "org", "user"];
  }

  if (layer === "user") {
    return withProfile(
      ["policy", "org"],
      layers.policy?.profile !== undefined || layers.org?.profile !== undefined,
    );
  }

  if (layer === "org") {
    return withProfile(["policy"], layers.policy?.profile !== undefined);
  }

  return [];
};

const lockingSource = (state: State, leaf: Leaf, rule: Rule, lockers: readonly ConfigSource[]) => {
  const source =
    state.sources[rule.lockKey ?? leaf.key] ?? (rule.lockedWhenUnset === true ? "default" : undefined);

  return source !== undefined && (rule.lockers ?? lockers).includes(source) ? source : undefined;
};

const describeSource = (source: ConfigSource, layers: Layers) => {
  if (source === "default") {
    return "the defaults";
  }

  return source === "profile" ? `profile ${resolveProfileName(layers)}` : source;
};

const assertTightens = (state: State, layerName: LayerName, layer: LayerConfig, layers: Layers) => {
  const lockers = lockersFor(layerName, layers);

  definedLeaves(layer).forEach(({ leaf, value }) => {
    const rule = leaf.rule;
    const lock = rule === undefined ? undefined : lockingSource(state, leaf, rule, lockers);
    const problem =
      rule === undefined || lock === undefined ? undefined : rule.problem(state.values[leaf.key], value);

    if (lock !== undefined && problem !== undefined) {
      throw new LauncherError(
        `${layerName}: ${leaf.key} ${problem}, locked by ${describeSource(lock, layers)}`,
        `remove ${leaf.key} from the ${layerName} config`,
      );
    }
  });
};

const applyLayer = (state: State, layerName: LayerName, layers: Layers): State => {
  const layer = layers[layerName];

  if (layer === undefined) {
    return state;
  }

  assertTightens(state, layerName, layer, layers);

  return overlay(state, layer, layerName);
};

const SKELETON = {
  image: {},
  egress: {},
  tls: {},
  mounts: {},
  env: {},
  ssh: {},
  resources: {},
  sessions: {},
};

const depthOf = (key: string) => key.split(".").length;

const toConfig = (values: Record<string, unknown>) =>
  Object.entries(values)
    .sort(([left], [right]) => depthOf(left) - depthOf(right))
    .reduce<Record<string, unknown>>(
      (config, [key, value]) => setPath(config, key, value),
      SKELETON,
    ) as unknown as SandboxConfig;

const capOf = (layer: LayerConfig | undefined, optIn: (layer: LayerConfig) => boolean) => {
  const allow = layer?.egress?.allow;

  return layer === undefined || allow === undefined || optIn(layer) ? undefined : allow;
};

const intersect = (lists: string[][]) =>
  lists.length === 0 ? undefined : lists.reduce((kept, next) => kept.filter((entry) => next.includes(entry)));

const capFor = (layers: Layers, optIn: (layer: LayerConfig) => boolean) =>
  intersect(
    CAP_LAYERS.map((name) => capOf(layers[name], optIn)).filter(
      (list): list is string[] => list !== undefined,
    ),
  );

const grantsOptIn = (layer: LayerConfig) => layer.egress?.grants?.enabled === true;

const grantCapsOf = (layers: Layers) =>
  CAP_LAYERS.flatMap((layer) => {
    const allow = capOf(layers[layer], grantsOptIn);

    return allow === undefined ? [] : [{ layer, allow }];
  });

const egressCapOf = (layers: Layers): EgressCap => {
  const derivedHosts = capFor(layers, (layer) => layer.credentials?.derive?.enabled === true);
  const grants = capFor(layers, grantsOptIn);

  return {
    ...(derivedHosts === undefined ? {} : { derivedHosts }),
    ...(grants === undefined ? {} : { grants }),
  };
};

export const mergeLayers = ({ defaults, layers, profile }: MergeInput): EffectiveConfig => {
  const base = overlay(overlay({ values: {}, sources: {} }, defaults, "default"), profile, "profile");
  const merged = LAYER_ORDER.reduce((state, layerName) => applyLayer(state, layerName, layers), base);

  return {
    config: toConfig(merged.values),
    sources: merged.sources,
    egressCap: egressCapOf(layers),
    grantCaps: grantCapsOf(layers),
  };
};
