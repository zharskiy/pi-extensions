import { homedir } from "node:os";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../hostpi/index.ts";
import { expandHome, GUEST_PATHS, isWithin } from "../shared/index.ts";
import { sourceOfEntry, withoutSourceCredential } from "./package-source.ts";
import { hostAgentsSkillsDir } from "./render.ts";

export interface HostSettingsContext {
  hostAgentDir: string;
  mountRoots: string[];
  home?: string;
}

const SANDBOX_DROPPED_SETTINGS = [
  "npmCommand",
  "selfUpdateCommand",
  "shellPath",
  "shellCommandPrefix",
  "externalEditor",
  "httpProxy",
  "sessionDir",
];

const RESOURCE_ARRAYS = ["extensions", "skills", "prompts", "themes"];

const FILE_URL = /^file:\/\//;

const PATTERN_PREFIX = /^[!+-]/;

const GLOB = /[*?]/;

const NAMED_RESOURCE = /^[a-z][\w+.-]*:/i;

const without = (settings: JsonObject, keys: string[]) =>
  Object.fromEntries(Object.entries(settings).filter(([key]) => !keys.includes(key)));

export const sandboxSettings = (host: JsonObject): JsonObject => without(host, SANDBOX_DROPPED_SETTINGS);

const isLocalSource = (source: string) =>
  source.startsWith("/") || source.startsWith("~") || source.startsWith(".") || FILE_URL.test(source);

const localPathOf = (source: string, context: HostSettingsContext) => {
  const expanded = FILE_URL.test(source) ? fileURLToPath(source) : expandHome(source, context.home);

  return isAbsolute(expanded) ? expanded : resolve(context.hostAgentDir, expanded);
};

const isMounted = (path: string, context: HostSettingsContext) =>
  context.mountRoots.some((root) => isWithin(path, root));

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

const isNamedResource = (path: string) => NAMED_RESOURCE.test(path) && !FILE_URL.test(path);

const isRootedPath = (path: string) => path.startsWith("/") || path.startsWith("~") || FILE_URL.test(path);

const splitGlob = (path: string) => {
  const segments = path.split("/");
  const firstGlob = segments.findIndex((segment) => GLOB.test(segment));

  return firstGlob === -1
    ? { fixed: path, glob: "" }
    : { fixed: segments.slice(0, firstGlob).join("/") || "/", glob: segments.slice(firstGlob).join("/") };
};

const guestLocations = (context: HostSettingsContext) => [
  { host: hostAgentsSkillsDir(context.home ?? homedir()), guest: GUEST_PATHS.agentsSkills },
  { host: context.hostAgentDir, guest: GUEST_PATHS.agentDir },
];

const guestPathOf = (path: string, context: HostSettingsContext) => {
  const carried = guestLocations(context).find((location) => isWithin(path, location.host));

  return carried === undefined
    ? undefined
    : posix.join(carried.guest, ...relative(carried.host, path).split(sep));
};

const sandboxPathOf = (path: string, context: HostSettingsContext) => {
  const { fixed, glob } = splitGlob(path);
  const hostPath = localPathOf(fixed, context);
  const placed = isMounted(hostPath, context) ? hostPath : guestPathOf(hostPath, context);

  return placed === undefined || glob === "" ? placed : posix.join(placed, glob);
};

const placedResource = (key: string, entry: unknown, context: HostSettingsContext) => {
  if (typeof entry !== "string") {
    return { entry };
  }

  const prefix = PATTERN_PREFIX.exec(entry)?.[0] ?? "";
  const isPattern = prefix !== "" || GLOB.test(entry);
  const path = isPattern ? entry.slice(prefix.length) : entry.trim();

  if (isNamedResource(path) || (isPattern && !isRootedPath(path))) {
    return { entry };
  }

  const placed = sandboxPathOf(path, context);

  return placed === undefined
    ? {
        notice: `settings.json: ${key} entry ${entry} lies outside the sandbox mounts, the agent dir and ~/.agents/skills; skipped in the sandbox`,
      }
    : { entry: `${prefix}${placed}` };
};

const placedResources = (settings: JsonObject, context: HostSettingsContext) => {
  const placed = RESOURCE_ARRAYS.flatMap((key) => {
    const entries = settings[key];

    if (!Array.isArray(entries)) {
      return [];
    }

    const outcomes = entries.map((entry) => placedResource(key, entry, context));

    return [
      {
        key,
        entries: outcomes.flatMap((outcome) => ("entry" in outcome ? [outcome.entry] : [])),
        notices: outcomes.flatMap((outcome) => (outcome.notice === undefined ? [] : [outcome.notice])),
      },
    ];
  });

  return {
    settings: {
      ...settings,
      ...Object.fromEntries(placed.map((resource) => [resource.key, resource.entries])),
    },
    notices: placed.flatMap((resource) => resource.notices),
  };
};

export const prepareHostSettings = (host: JsonObject, context: HostSettingsContext) => {
  const { settings, notices } = placedResources(host, context);

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
