import { isJsonObject } from "../shared/index.ts";
import { getPath, setPath } from "./dotted.ts";
import type {
  ConfigSource,
  EffectiveConfig,
  IgnoredKey,
  LayerConfig,
  LayerName,
  SandboxConfig,
} from "./types.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

interface State {
  values: Record<string, unknown>;
  sources: Record<string, ConfigSource>;
  ignored: IgnoredKey[];
}

interface Leaf {
  key: string;
  value: unknown;
}

const LAYER_ORDER: readonly LayerName[] = ["policy", "org", "user", "project"];

const FINAL_SOURCES: readonly ConfigSource[] = ["policy", "org"];

const UNION_KEYS = [
  "egress.allow",
  "egress.deny",
  "egress.privateHosts",
  "image.packages",
  "credentials.rules",
  "env.allow",
];

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

const definedLeaves = (layer: unknown): Leaf[] =>
  LEAF_KEYS.map((key) => ({ key, value: getPath(layer, key) })).filter(({ value }) => value !== undefined);

const isUnion = (key: string) => UNION_KEYS.includes(key);

const identityOf = (item: unknown) =>
  isJsonObject(item) && typeof item.id === "string" ? item.id : JSON.stringify(item);

const takenBy = (list: unknown[], item: unknown) =>
  list.find((entry) => identityOf(entry) === identityOf(item));

const unite = (current: unknown[], added: unknown[]) => {
  const fresh = added.filter(
    (item, index) =>
      takenBy(current, item) === undefined &&
      added.findIndex((other) => identityOf(other) === identityOf(item)) === index,
  );
  const repeated = added.filter((item) => {
    const taken = takenBy(current, item);

    return taken !== undefined && JSON.stringify(taken) !== JSON.stringify(item);
  });

  return { list: [...current, ...fresh], repeated: repeated.map(identityOf) };
};

const finalSource = (state: State, key: string) => {
  const source = state.sources[key];

  return !isUnion(key) && source !== undefined && FINAL_SOURCES.includes(source) ? source : undefined;
};

const setLeaf = (state: State, source: ConfigSource, { key, value }: Leaf): State => {
  const final = finalSource(state, key);

  if (final !== undefined) {
    return {
      ...state,
      ignored: [...state.ignored, { layer: source, key, reason: `final in the ${final} config` }],
    };
  }

  const current = state.values[key];
  const united =
    isUnion(key) && Array.isArray(current)
      ? unite(current, value as unknown[])
      : { list: value, repeated: [] };
  const repeated = united.repeated.map((identity) => ({
    layer: source,
    key: `${key} ${identity}`,
    reason: "a higher layer has a rule with this id",
  }));

  return {
    values: { ...state.values, [key]: united.list },
    sources: { ...state.sources, [key]: source },
    ignored: [...state.ignored, ...repeated],
  };
};

const overlay = (state: State, layer: unknown, source: ConfigSource): State =>
  definedLeaves(layer).reduce<State>((next, leaf) => setLeaf(next, source, leaf), state);

const applyLayer = (state: State, layerName: LayerName, layers: Layers): State => {
  const layer = layers[layerName];

  return layer === undefined ? state : overlay(state, layer, layerName);
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
  ignored = [],
}: {
  defaults: SandboxConfig;
  layers: Layers;
  ignored?: IgnoredKey[];
}): EffectiveConfig => {
  const base = overlay({ values: {}, sources: {}, ignored }, defaults, "default");
  const merged = LAYER_ORDER.reduce((state, layerName) => applyLayer(state, layerName, layers), base);

  return { config: toConfig(merged.values), sources: merged.sources, ignored: merged.ignored };
};

const groupOf = (entry: IgnoredKey) => `${entry.layer}|${entry.reason}`;

export const ignoredNotice = (ignored: IgnoredKey[]) => {
  if (ignored.length === 0) {
    return [];
  }

  const groups = [...new Set(ignored.map(groupOf))].map((group) => {
    const members = ignored.filter((entry) => groupOf(entry) === group);
    const [first] = members;

    return `${first?.layer} ${members.map((entry) => entry.key).join(", ")} (${first?.reason})`;
  });

  return [`pi-sandbox: warning: config keys ignored: ${groups.join("; ")}; see pi sandbox config`];
};
