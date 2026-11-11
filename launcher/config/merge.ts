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
import { leafKeys } from "./validate.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

interface State {
  values: Record<string, unknown>;
  sources: Record<string, string>;
  ignored: IgnoredKey[];
}

interface Leaf {
  key: string;
  value: unknown;
}

const LAYER_ORDER: readonly LayerName[] = ["policy", "user"];

const FINAL_SOURCE = "policy";

const LOCKED_KEYS = ["egress.allow", "egress.privateHosts"];

const UNION_KEYS = [
  "egress.allow",
  "egress.deny",
  "egress.privateHosts",
  "image.packages",
  "image.npmGlobal",
  "credentials.rules",
  "env.allow",
];

const LEAF_KEYS = leafKeys();

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

  return { list: [...current, ...fresh], repeated: repeated.map(identityOf), added: fresh.length };
};

const locksEgress = (source: string | undefined, grants: unknown) =>
  source === FINAL_SOURCE && grants === false;

const isLocked = (state: State, key: string) =>
  LOCKED_KEYS.includes(key) && locksEgress(state.sources["egress.grants"], state.values["egress.grants"]);

export const isEgressLocked = (effective: EffectiveConfig) =>
  locksEgress(effective.sources["egress.grants"], effective.config.egress.grants);

const finalReason = (state: State, key: string) => {
  if (isLocked(state, key)) {
    return "egress is locked: the policy config sets egress.grants to false";
  }

  return !isUnion(key) && state.sources[key] === FINAL_SOURCE ? "final in the policy config" : undefined;
};

const sourceAfter = (state: State, key: string, source: ConfigSource, added: number) => {
  const current = state.sources[key];

  if (!isUnion(key) || current === undefined || current === "default") {
    return source;
  }

  return added === 0 ? current : `${current}+${source}`;
};

const setLeaf = (state: State, source: ConfigSource, { key, value }: Leaf): State => {
  const reason = source === FINAL_SOURCE ? undefined : finalReason(state, key);

  if (reason !== undefined) {
    return { ...state, ignored: [...state.ignored, { layer: source, key, reason }] };
  }

  const current = state.values[key];
  const united =
    isUnion(key) && Array.isArray(current)
      ? unite(current, value as unknown[])
      : { list: value, repeated: [], added: 1 };
  const repeated = united.repeated.map((identity) => ({
    layer: source,
    key: `${key} ${identity}`,
    reason: "a higher layer has a rule with this id",
  }));

  return {
    values: { ...state.values, [key]: united.list },
    sources: { ...state.sources, [key]: sourceAfter(state, key, source, united.added) },
    ignored: [...state.ignored, ...repeated],
  };
};

const overlay = (state: State, layer: unknown, source: ConfigSource): State =>
  definedLeaves(layer).reduce<State>((next, leaf) => setLeaf(next, source, leaf), state);

const applyLayer = (state: State, layerName: LayerName, layers: Layers): State => {
  const layer = layers[layerName];

  return layer === undefined ? state : overlay(state, layer, layerName);
};

const toConfig = (values: Record<string, unknown>) =>
  Object.entries(values).reduce<Record<string, unknown>>(
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
  const base = overlay({ values: {}, sources: {}, ignored: [] }, defaults, "default");
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
