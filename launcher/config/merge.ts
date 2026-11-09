import { LauncherError } from "../shared/index.ts";
import { getPath, setPath } from "./dotted.ts";
import type { ConfigSource, EffectiveConfig, LayerConfig, LayerName, SandboxConfig } from "./types.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

interface State {
  values: Record<string, unknown>;
  sources: Record<string, ConfigSource>;
}

const LAYER_ORDER: readonly LayerName[] = ["policy", "org", "user", "project"];

const FINAL_SOURCES: readonly ConfigSource[] = ["policy", "org"];

const UNION_KEYS = ["egress.deny", "env.allow"];

const LEAF_KEYS = [
  "fallback",
  "image.reference",
  "image.digest",
  "image.packages",
  "image.npmGlobal",
  "image.dockerfile",
  "credentials.rules",
  "credentials.derive.enabled",
  "credentials.derive.hosts",
  "egress.allow",
  "egress.presets",
  "egress.deny",
  "egress.privateHosts",
  "egress.parentProxy",
  "egress.grants",
  "tls.extraCa",
  "workspaceRoots",
  "mounts.extraReadOnly",
  "mounts.cacheVolumes",
  "mounts.sharedCaches",
  "mounts.hostCaches",
  "mounts.autoOverlays",
  "env.allow",
  "resources.cpus",
  "resources.memoryGiB",
  "sessions.host",
  "org",
];

const SKELETON = {
  image: {},
  egress: {},
  tls: {},
  mounts: {},
  env: {},
  resources: {},
  sessions: {},
};

const definedLeaves = (layer: unknown) =>
  LEAF_KEYS.map((key) => ({ key, value: getPath(layer, key) })).filter(({ value }) => value !== undefined);

const isUnion = (key: string) => UNION_KEYS.includes(key);

const combine = (current: unknown, key: string, value: unknown) =>
  isUnion(key) && Array.isArray(current) ? [...new Set([...current, ...(value as unknown[])])] : value;

const overlay = (state: State, layer: unknown, source: ConfigSource): State =>
  definedLeaves(layer).reduce<State>(
    (next, { key, value }) => ({
      values: { ...next.values, [key]: combine(next.values[key], key, value) },
      sources: { ...next.sources, [key]: source },
    }),
    state,
  );

const assertNotFinal = (state: State, layerName: LayerName, layer: LayerConfig) => {
  const taken = definedLeaves(layer).find(
    ({ key }) => !isUnion(key) && FINAL_SOURCES.includes(state.sources[key] ?? "default"),
  );

  if (taken !== undefined) {
    throw new LauncherError(
      `${layerName}: ${taken.key} is set by the ${state.sources[taken.key]} config and is final there`,
      `remove ${taken.key} from the ${layerName} config`,
    );
  }
};

const applyLayer = (state: State, layerName: LayerName, layers: Layers): State => {
  const layer = layers[layerName];

  if (layer === undefined) {
    return state;
  }

  assertNotFinal(state, layerName, layer);

  return overlay(state, layer, layerName);
};

const depthOf = (key: string) => key.split(".").length;

const toConfig = (values: Record<string, unknown>) =>
  Object.entries(values)
    .sort(([left], [right]) => depthOf(left) - depthOf(right))
    .reduce<Record<string, unknown>>(
      (config, [key, value]) => setPath(config, key, value),
      SKELETON,
    ) as unknown as SandboxConfig;

export const mergeLayers = ({
  defaults,
  layers,
}: {
  defaults: SandboxConfig;
  layers: Layers;
}): EffectiveConfig => {
  const base = overlay({ values: {}, sources: {} }, defaults, "default");
  const merged = LAYER_ORDER.reduce((state, layerName) => applyLayer(state, layerName, layers), base);

  return { config: toConfig(merged.values), sources: merged.sources };
};
