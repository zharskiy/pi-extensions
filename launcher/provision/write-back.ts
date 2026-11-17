import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../hostpi/index.ts";
import { isJsonObject, parseJsonObject } from "../shared/index.ts";

type ValueCheck = (value: unknown) => boolean;

export interface SyncedFile {
  name: string;
  keys: readonly string[];
  maxBytes: number;
  checks?: Readonly<Record<string, ValueCheck>>;
  entryMerged?: readonly string[];
  entryNameChecks?: Readonly<Record<string, (name: string) => boolean>>;
}

interface KeyChange {
  key: string;
  from: unknown;
  to: unknown;
}

interface FileSides {
  baseline: JsonObject;
  volume: JsonObject;
  host: JsonObject;
}

export type Baseline = Record<string, JsonObject>;

type VolumeParse = { value: JsonObject } | { notices: string[] };

const KIB = 1024;

const EXTENSION_FILE_BYTES = 64 * KIB;

const SETTINGS_FILE_BYTES = 1024 * KIB;

const SHOWN_CHARS = 60;

const PRINTABLE_FROM = 0x20;

const C1_FROM = 0x7f;

const C1_TO = 0x9f;

const BIDI_CONTROL = /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const MAX_STRING_CHARS = 512;

const THEME_NAME = /^[A-Za-z0-9._-]+$/;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const QUEUE_MODES = ["all", "one-at-a-time"];

const DOUBLE_ESCAPE_ACTIONS = ["fork", "tree", "none"];

const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"];

const isBoundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_STRING_CHARS;

const isBoolean = (value: unknown) => typeof value === "boolean";

const isControl = (char: string) => {
  const code = char.codePointAt(0) ?? 0;

  return code < PRINTABLE_FROM || (code >= C1_FROM && code <= C1_TO) || BIDI_CONTROL.test(char);
};

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;

const MAX_SOURCE_CHARS = 512;

const MARKER_SCOPES = ["user", "project", "temporary"];

const isVersion = (value: unknown) => typeof value === "string" && VERSION.test(value);

const parsedObject = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);

    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const isPrintableText = (text: string) => !Array.from(text).some((char) => isControl(char));

const isChangelogMarkerName = (name: string) => {
  const marker = parsedObject(name);
  const source = marker?.source;

  return (
    marker !== undefined &&
    Object.keys(marker).length === 2 &&
    typeof source === "string" &&
    source.length > 0 &&
    source.length <= MAX_SOURCE_CHARS &&
    isPrintableText(source) &&
    MARKER_SCOPES.includes(marker.scope as string)
  );
};

const oneOf =
  (allowed: readonly unknown[]): ValueCheck =>
  (value) =>
    allowed.includes(value);

const isStringList = (value: unknown) => Array.isArray(value) && value.every(isBoundedString);

const isThemeName = (value: unknown) =>
  isBoundedString(value) && THEME_NAME.test(value) && value !== "." && value !== "..";

export const SETTINGS_FILE: SyncedFile = {
  name: "settings.json",
  keys: [
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "enabledModels",
    "theme",
    "hideThinkingBlock",
    "quietStartup",
    "collapseChangelog",
    "doubleEscapeAction",
    "treeFilterMode",
    "steeringMode",
    "followUpMode",
    "extensionChangelogVersions",
  ],
  maxBytes: SETTINGS_FILE_BYTES,
  entryMerged: ["extensionChangelogVersions"],
  checks: {
    defaultProvider: isBoundedString,
    defaultModel: isBoundedString,
    defaultThinkingLevel: oneOf(THINKING_LEVELS),
    enabledModels: isStringList,
    theme: isThemeName,
    hideThinkingBlock: isBoolean,
    quietStartup: (value) => isBoolean(value) || value === "header",
    collapseChangelog: isBoolean,
    doubleEscapeAction: oneOf(DOUBLE_ESCAPE_ACTIONS),
    treeFilterMode: oneOf(TREE_FILTER_MODES),
    steeringMode: oneOf(QUEUE_MODES),
    followUpMode: oneOf(QUEUE_MODES),
    extensionChangelogVersions: isVersion,
  },
  entryNameChecks: { extensionChangelogVersions: isChangelogMarkerName },
};

export const EXTENSION_FILES: readonly SyncedFile[] = [
  {
    name: "pi-subagents.json",
    keys: [
      "maxConcurrent",
      "maxDepth",
      "softContextRatio",
      "hardContextRatio",
      "reserveTokens",
      "inlineResultChars",
      "failedLingerMs",
      "doneLingerMs",
      "renderThrottleMs",
      "stopGraceSeconds",
      "maxChainLength",
      "maxChildrenPerAgent",
      "fetchTimeoutSeconds",
      "fetchMaxBytes",
      "fetchMaxChars",
      "agents",
    ],
    maxBytes: EXTENSION_FILE_BYTES,
  },
  { name: "pi-style.json", keys: ["style"], maxBytes: EXTENSION_FILE_BYTES },
  {
    name: "pi-notifications.json",
    keys: ["channel", "idleDelayMs", "dialogDelayMs"],
    maxBytes: EXTENSION_FILE_BYTES,
  },
  {
    name: "pi-session-limits.json",
    keys: ["softRatio", "hardRatio", "softTokens", "hardTokens"],
    maxBytes: EXTENSION_FILE_BYTES,
  },
];

export const SYNCED_FILES: readonly SyncedFile[] = [SETTINGS_FILE, ...EXTENSION_FILES];

export const syncedValues = (file: SyncedFile, value: JsonObject | undefined): JsonObject =>
  value === undefined
    ? {}
    : Object.fromEntries(
        file.keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
      );

const sizeText = (bytes: number) => `${bytes / KIB} KiB`;

export const parseVolumeText = (file: SyncedFile, text: string | undefined): VolumeParse => {
  if (text === undefined) {
    return { notices: [] };
  }

  if (Buffer.byteLength(text) > file.maxBytes) {
    return {
      notices: [`${file.name} in the sandbox is larger than ${sizeText(file.maxBytes)}; not written back`],
    };
  }

  const value = parseJsonObject(text);

  return value === undefined
    ? { notices: [`${file.name} in the sandbox is not a JSON object; not written back`] }
    : { value };
};

export const parseBaseline = (value: unknown): Baseline | undefined => {
  const files = isJsonObject(value) ? value.files : undefined;

  if (!isJsonObject(files) || !SYNCED_FILES.every((file) => isJsonObject(files[file.name]))) {
    return undefined;
  }

  return Object.fromEntries(
    SYNCED_FILES.map((file) => [file.name, syncedValues(file, files[file.name] as JsonObject)]),
  );
};

export const baselineRecord = (baseline: Baseline) => ({ files: baseline });

const keyValue = (object: JsonObject, key: string) => (Object.hasOwn(object, key) ? object[key] : undefined);

const isAccepted = (file: SyncedFile, key: string, value: unknown) =>
  value === undefined || (file.checks?.[key]?.(value) ?? true);

interface Decision {
  change?: KeyChange;
  notice?: string;
}

const decideKey = (file: SyncedFile, key: string, sides: FileSides, shownKey = key): Decision => {
  const baseline = keyValue(sides.baseline, key);
  const volume = keyValue(sides.volume, key);
  const host = keyValue(sides.host, key);

  if (isDeepStrictEqual(volume, baseline) || isDeepStrictEqual(host, volume)) {
    return {};
  }

  const badName =
    shownKey !== key && volume !== undefined && file.entryNameChecks?.[shownKey]?.(key) === false;

  if (badName || !isAccepted(file, shownKey, volume)) {
    return { notice: `${file.name}: ${shownKey} in the sandbox is not a valid value; not written back` };
  }

  return isDeepStrictEqual(host, baseline)
    ? { change: { key, from: host, to: volume } }
    : { notice: `${file.name}: ${shownKey} changed on the host and in the sandbox; kept the host value` };
};

const objectSide = (side: JsonObject, key: string) => {
  const value = keyValue(side, key);

  return isJsonObject(value) ? value : {};
};

const decideEntries = (file: SyncedFile, key: string, sides: FileSides): Decision[] => {
  const volume = keyValue(sides.volume, key);

  if (volume !== undefined && !isJsonObject(volume)) {
    return [{ notice: `${file.name}: ${key} in the sandbox is not a valid value; not written back` }];
  }

  const entries = {
    baseline: objectSide(sides.baseline, key),
    volume: objectSide(sides.volume, key),
    host: objectSide(sides.host, key),
  };
  const names = [...new Set([...Object.keys(entries.baseline), ...Object.keys(entries.volume)])];
  const decided = names.map((name) => decideKey(file, name, entries, key));
  const changes = decided.flatMap((entry) => (entry.change === undefined ? [] : [entry.change]));
  const notices = decided
    .filter((entry) => entry.notice !== undefined)
    .map((entry) => ({ notice: entry.notice }));

  if (changes.length === 0) {
    return notices;
  }

  const from = keyValue(sides.host, key);
  const merged = applyChanges(entries.host, changes);

  return [{ change: { key, from, to: Object.keys(merged).length === 0 ? undefined : merged } }, ...notices];
};

export const mergeFile = (file: SyncedFile, sides: FileSides) => {
  const decided = file.keys.flatMap((key) =>
    file.entryMerged?.includes(key) ? decideEntries(file, key, sides) : [decideKey(file, key, sides)],
  );

  return {
    changes: decided.flatMap((entry) => (entry.change === undefined ? [] : [entry.change])),
    notices: decided.flatMap((entry) => (entry.notice === undefined ? [] : [entry.notice])),
  };
};

export const applyChanges = (host: JsonObject, changes: readonly KeyChange[]): JsonObject => {
  const removed = new Set(changes.filter((change) => change.to === undefined).map((change) => change.key));
  const kept = Object.fromEntries(Object.entries(host).filter(([key]) => !removed.has(key)));
  const updates = changes
    .filter((change) => change.to !== undefined)
    .map((change) => [change.key, change.to]);

  return { ...kept, ...Object.fromEntries(updates) };
};

const printable = (text: string) =>
  Array.from(text)
    .map((char) => (isControl(char) ? "?" : char))
    .join("");

const shown = (value: unknown) => {
  if (value === undefined) {
    return "(unset)";
  }

  const text = printable(typeof value === "string" ? value : JSON.stringify(value));

  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS - 1)}…` : text;
};

export const changeLine = (file: SyncedFile, change: KeyChange) =>
  `${file.name} ${change.key}: ${shown(change.from)} → ${shown(change.to)} written to the host`;
