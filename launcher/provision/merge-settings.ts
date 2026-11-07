import { isAbsolute, resolve } from "node:path";
import { type JsonObject, packageSourceKey, sourceOfEntry } from "../hostpi/index.ts";
import { expandHome, isWithin, stableHash } from "../shared/index.ts";

export interface HostSettingsContext {
  hostAgentDir: string;
  mountRoots: string[];
  home?: string;
  bakedInVolume: boolean;
}

export const BAKED_EXTENSIONS_SOURCE = "/opt/pi-sandbox/extensions/node_modules/pi-extensions-mz";

const EXTENSIONS_NPM_KEY = "npm:pi-extensions-mz";

const sameValue = (left: unknown, right: unknown) =>
  left === undefined || right === undefined ? left === right : stableHash(left) === stableHash(right);

const decide = (key: string, base: JsonObject | undefined, host: JsonObject, volume: JsonObject) => {
  const inHost = Object.hasOwn(host, key);
  const inBase = base !== undefined && Object.hasOwn(base, key);
  const hostChanged = base === undefined || inHost !== inBase || !sameValue(base[key], host[key]);

  if (inHost && hostChanged) {
    return { keep: true, value: host[key] };
  }

  if (!inHost && inBase) {
    return { keep: false };
  }

  return Object.hasOwn(volume, key) ? { keep: true, value: volume[key] } : { keep: false };
};

export const mergeTopLevel = (
  base: JsonObject | undefined,
  host: JsonObject,
  volume: JsonObject | undefined,
): JsonObject => {
  if (volume === undefined) {
    return { ...host };
  }

  const keys = [...new Set([...Object.keys(volume), ...Object.keys(host)])];

  return Object.fromEntries(
    keys.flatMap((key) => {
      const decision = decide(key, base, host, volume);

      return decision.keep ? [[key, decision.value]] : [];
    }),
  );
};

const isLocalSource = (source: string) =>
  source.startsWith("/") || source.startsWith("~") || source.startsWith(".");

const localPathOf = (source: string, context: HostSettingsContext) => {
  const expanded = expandHome(source, context.home);

  return isAbsolute(expanded) ? expanded : resolve(context.hostAgentDir, expanded);
};

const isMounted = (source: string, context: HostSettingsContext) => {
  const path = localPathOf(source, context);

  return context.mountRoots.some((root) => isWithin(path, root));
};

const bakedEntry = (entry: unknown) =>
  typeof entry === "string"
    ? BAKED_EXTENSIONS_SOURCE
    : { ...(entry as JsonObject), source: BAKED_EXTENSIONS_SOURCE };

const hostPackage = (entry: unknown, context: HostSettingsContext) => {
  const source = sourceOfEntry(entry);

  if (source === undefined) {
    return { entry };
  }

  if (context.bakedInVolume && packageSourceKey(source) === EXTENSIONS_NPM_KEY) {
    return { entry: bakedEntry(entry) };
  }

  if (isLocalSource(source) && !isMounted(source, context)) {
    return {
      notice: `settings.json: package ${source} is a local path outside the sandbox mounts; skipped in the sandbox`,
    };
  }

  return { entry };
};

export const prepareHostSettings = (settings: JsonObject, context: HostSettingsContext) => {
  if (!Array.isArray(settings.packages)) {
    return { settings, notices: [] };
  }

  const outcomes = settings.packages.map((entry) => hostPackage(entry, context));

  return {
    settings: {
      ...settings,
      packages: outcomes.flatMap((outcome) => ("entry" in outcome ? [outcome.entry] : [])),
    },
    notices: outcomes.flatMap((outcome) => (outcome.notice === undefined ? [] : [outcome.notice])),
  };
};

const isBaked = (entry: unknown) => sourceOfEntry(entry) === BAKED_EXTENSIONS_SOURCE;

export const hasBakedPackage = (settings: JsonObject | undefined) =>
  Array.isArray(settings?.packages) && settings.packages.some(isBaked);

export const keepBakedPackage = (merged: JsonObject, volume: JsonObject | undefined) => {
  if (!hasBakedPackage(volume) || hasBakedPackage(merged)) {
    return merged;
  }

  const packages = Array.isArray(merged.packages) ? merged.packages : [];
  const baked = (Array.isArray(volume?.packages) ? volume.packages : []).find(isBaked);

  return { ...merged, packages: [baked, ...packages] };
};
