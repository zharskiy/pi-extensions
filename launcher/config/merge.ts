import { isDeepStrictEqual } from "node:util";
import { expandHome, isWithin, LauncherError } from "../shared/index.ts";
import { getPath, setPath } from "./dotted.ts";
import type {
  ConfigSource,
  EffectiveConfig,
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
}

interface State {
  values: Record<string, unknown>;
  sources: Record<string, ConfigSource>;
}

const LAYER_ORDER: readonly LayerName[] = ["policy", "user", "project"];

const unchanged = (above: unknown, below: unknown) =>
  isDeepStrictEqual(above, below) ? undefined : "cannot change";

const unchangedWhenSet = (above: unknown, below: unknown) =>
  above === undefined ? undefined : unchanged(above, below);

const subset = (above: unknown, below: unknown) => {
  const allowed = (above as string[] | undefined) ?? [];
  const added = (below as string[]).filter((entry) => !allowed.includes(entry));

  return added.length === 0 ? undefined : `cannot add ${added.join(", ")}`;
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
  { key: "gateway", rule: { problem: unchanged, lockedWhenUnset: true } },
  { key: "credentials", rule: { problem: unchanged } },
  { key: "egress.allow", rule: { problem: subset } },
  { key: "egress.mcpHosts", rule: { problem: subset } },
  { key: "egress.denyPrivateAddresses" },
  { key: "workspaceRoots", rule: { problem: narrowerRoots } },
  { key: "mounts.extraReadOnly", rule: { problem: subset } },
  { key: "mounts.cacheVolumes" },
  { key: "env.allow", union: true },
  { key: "ssh.agent", rule: { problem: staysOff } },
  { key: "resources.cpus" },
  { key: "resources.memoryGiB" },
];

const definedLeaves = (layer: unknown) =>
  LEAVES.map((leaf) => ({ leaf, value: getPath(layer, leaf.key) })).filter(
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
  layers.policy?.profile ?? layers.user?.profile ?? layers.project?.profile;

const lockersFor = (layer: LayerName, layers: Layers): readonly ConfigSource[] => {
  if (layer === "project") {
    return ["default", "profile", "policy", "user"];
  }

  if (layer === "user") {
    return layers.policy?.profile === undefined ? ["policy"] : ["policy", "profile"];
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

const SKELETON = { image: {}, egress: {}, mounts: {}, env: {}, ssh: {}, resources: {} };

const toConfig = (values: Record<string, unknown>) =>
  Object.entries(values).reduce<Record<string, unknown>>(
    (config, [key, value]) => setPath(config, key, value),
    SKELETON,
  ) as unknown as SandboxConfig;

export const mergeLayers = ({ defaults, layers, profile }: MergeInput): EffectiveConfig => {
  const base = overlay(overlay({ values: {}, sources: {} }, defaults, "default"), profile, "profile");
  const merged = LAYER_ORDER.reduce((state, layerName) => applyLayer(state, layerName, layers), base);

  return { config: toConfig(merged.values), sources: merged.sources };
};
