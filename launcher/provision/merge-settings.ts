import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import { HOST_ONLY_SETTINGS, isFileUrl, isWithin, pathFromSetting } from "../shared/index.ts";
import { sourceOfEntry, withoutSourceCredential, withSource } from "./package-source.ts";

export interface HostSettingsContext {
  hostAgentDir: string;
  mountRoots: string[];
  home?: string;
}

const RESOURCE_ARRAYS = ["extensions", "skills", "prompts", "themes"];

const without = (settings: JsonObject, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(settings).filter(([key]) => !keys.includes(key)));

export const sandboxSettings = (host: JsonObject): JsonObject => without(host, HOST_ONLY_SETTINGS);

const isLocalSource = (source: string) =>
  source.startsWith("/") || source.startsWith("~") || source.startsWith(".") || isFileUrl(source);

const localPathOf = (source: string, context: HostSettingsContext) => {
  const expanded = pathFromSetting(source, context.home);

  return isAbsolute(expanded) ? expanded : resolve(context.hostAgentDir, expanded);
};

const isMounted = (path: string, context: HostSettingsContext) =>
  context.mountRoots.some((root) => isWithin(path, root));

const withoutCredential = (entry: unknown) => {
  const source = sourceOfEntry(entry);
  const stripped = source === undefined ? undefined : withoutSourceCredential(source);

  return stripped === undefined
    ? { entry, notices: [] }
    : {
        entry: withSource(entry, stripped.source),
        notices: [
          `settings.json package ${stripped.host} carried a credential in its URL; it was removed inside the sandbox`,
        ],
      };
};

const placedPackage = (
  entry: unknown,
  context: HostSettingsContext,
): { entry?: unknown; notice?: string } => {
  const source = sourceOfEntry(entry);

  if (source === undefined || !isLocalSource(source)) {
    return { entry };
  }

  const path = localPathOf(source, context);

  return isMounted(path, context)
    ? { entry: withSource(entry, path) }
    : {
        notice: `settings.json: package ${source} is a local path outside the sandbox mounts; skipped in the sandbox`,
      };
};

const hostPackage = (original: unknown, context: HostSettingsContext) => {
  const cleaned = withoutCredential(original);
  const outcome = placedPackage(cleaned.entry, context);

  return {
    ...outcome,
    notices: [...cleaned.notices, ...(outcome.notice === undefined ? [] : [outcome.notice])],
  };
};

const outsideResource = (key: string, entry: unknown, context: HostSettingsContext) => {
  const path = typeof entry === "string" ? entry.replace(/^[!+-]/, "") : "";

  if (!(path.startsWith("/") || path.startsWith("~") || isFileUrl(path))) {
    return [];
  }

  const resolved = localPathOf(path, context);

  return isMounted(resolved, context)
    ? []
    : [`settings.json: ${key} entry ${path} lies outside the sandbox mounts and is missing in the sandbox`];
};

const resourceNotices = (settings: JsonObject, context: HostSettingsContext) =>
  RESOURCE_ARRAYS.flatMap((key) => {
    const entries = settings[key];

    return Array.isArray(entries) ? entries.flatMap((entry) => outsideResource(key, entry, context)) : [];
  });

export const prepareHostSettings = (settings: JsonObject, context: HostSettingsContext) => {
  const notices = resourceNotices(settings, context);

  if (!Array.isArray(settings.packages)) {
    return { settings, notices };
  }

  const outcomes = settings.packages.map((entry) => hostPackage(entry, context));

  return {
    settings: {
      ...settings,
      packages: outcomes.flatMap((outcome) => ("entry" in outcome ? [outcome.entry] : [])),
    },
    notices: [...outcomes.flatMap((outcome) => outcome.notices), ...notices],
  };
};
