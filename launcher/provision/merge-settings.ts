import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../hostpi/index.ts";
import { expandHome, isWithin } from "../shared/index.ts";
import { sourceOfEntry, withoutSourceCredential } from "./package-source.ts";

export interface HostSettingsContext {
  hostAgentDir: string;
  mountRoots: string[];
  home?: string;
}

const HOST_OWNED_SETTINGS = [
  "npmCommand",
  "selfUpdateCommand",
  "shellPath",
  "shellCommandPrefix",
  "externalEditor",
  "httpProxy",
];

const SANDBOX_DROPPED_SETTINGS = [...HOST_OWNED_SETTINGS, "sessionDir"];

const without = (settings: JsonObject, keys: string[]) =>
  Object.fromEntries(Object.entries(settings).filter(([key]) => !keys.includes(key)));

export const hostWinsSettings = (host: JsonObject, volume: JsonObject | undefined): JsonObject => ({
  ...without(volume ?? {}, HOST_OWNED_SETTINGS),
  ...without(host, SANDBOX_DROPPED_SETTINGS),
});

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

const withSource = (entry: unknown, source: string) =>
  typeof entry === "string" ? source : { ...(entry as JsonObject), source };

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

  if (source === undefined) {
    return { entry };
  }

  if (isLocalSource(source) && !isMounted(source, context)) {
    return {
      notice: `settings.json: package ${source} is a local path outside the sandbox mounts; skipped in the sandbox`,
    };
  }

  return { entry };
};

const hostPackage = (original: unknown, context: HostSettingsContext) => {
  const cleaned = withoutCredential(original);
  const outcome = placedPackage(cleaned.entry, context);

  return {
    ...outcome,
    notices: [...cleaned.notices, ...(outcome.notice === undefined ? [] : [outcome.notice])],
  };
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
    notices: outcomes.flatMap((outcome) => outcome.notices),
  };
};
