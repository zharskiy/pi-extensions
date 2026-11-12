import { getPath, setPath } from "./dotted.ts";
import type { ConfigSource, EffectiveConfig, SandboxConfig, UserConfig } from "./types.ts";
import { leafKeys } from "./validate.ts";

const LEAF_KEYS = leafKeys();

const definedKeys = (config: unknown) => LEAF_KEYS.filter((key) => getPath(config, key) !== undefined);

const sourcesOf = (keys: string[], source: (key: string) => ConfigSource) =>
  Object.fromEntries(keys.map((key) => [key, source(key)]));

const extended = (base: unknown, value: unknown) =>
  Array.isArray(base) && Array.isArray(value)
    ? [...base, ...value.filter((item) => !base.includes(item))]
    : value;

const EXTENDING_KEYS = new Set(["env.allow"]);

const configSource = (key: string): ConfigSource => (EXTENDING_KEYS.has(key) ? "default+config" : "config");

export const mergeConfig = (defaults: SandboxConfig, config: UserConfig = {}): EffectiveConfig => {
  const configured = definedKeys(config);
  const merged = configured.reduce<Record<string, unknown>>(
    (result, key) => setPath(result, key, extended(getPath(defaults, key), getPath(config, key))),
    defaults as unknown as Record<string, unknown>,
  );

  return {
    config: merged as unknown as SandboxConfig,
    sources: { ...sourcesOf(definedKeys(defaults), () => "default"), ...sourcesOf(configured, configSource) },
  };
};
