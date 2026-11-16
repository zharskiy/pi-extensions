export type ValueSpec =
  | { type: "string"; maxLength?: number }
  | { type: "boolean" }
  | { type: "integer"; min?: number; max?: number }
  | { type: "number"; min?: number; max?: number }
  | { type: "enum"; values: ReadonlyArray<string | number | boolean> }
  | { type: "stringList"; maxItems?: number }
  | { type: "fileName" }
  | { type: "anyOf"; of: readonly ValueSpec[] }
  | { type: "json" };

export type ValueType = ValueSpec["type"];

export type FileKeys = Readonly<Record<string, ValueSpec>>;

export type WriteBackTable = Readonly<Record<string, FileKeys>>;

export const SETTINGS_FILE_NAME = "settings.json";

export const MAX_WRITE_BACK_CHARS = 512;

const EXTENSION_FILE = /^pi-[a-z0-9-]+\.json$/;

const NEVER_WRITTEN_FILES = ["auth.json", "models.json", "mcp.json", "mcp-auth.json", "trust.json"];

export const HOST_ONLY_SETTINGS = [
  "npmCommand",
  "selfUpdateCommand",
  "shellPath",
  "shellCommandPrefix",
  "externalEditor",
  "httpProxy",
  "sessionDir",
];

const NEVER_WRITTEN_KEYS: Readonly<Record<string, readonly string[]>> = {
  [SETTINGS_FILE_NAME]: [
    ...HOST_ONLY_SETTINGS,
    "packages",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "defaultProjectTrust",
    "modelOverrides",
    "sessionShareDestination",
    "defaultTools",
    "enableAnalytics",
    "enableInstallTelemetry",
    "trackingId",
    "deviceId",
  ],
  "pi-subagents.json": ["disabledPlugins"],
};

const text: ValueSpec = { type: "string" };

const flag: ValueSpec = { type: "boolean" };

const json: ValueSpec = { type: "json" };

const oneOf = (values: readonly string[]): ValueSpec => ({ type: "enum", values });

const QUEUE_MODES = oneOf(["all", "one-at-a-time"]);

const jsonKeys = (keys: readonly string[]): FileKeys => Object.fromEntries(keys.map((key) => [key, json]));

export const BUILT_IN_WRITE_BACK: WriteBackTable = {
  [SETTINGS_FILE_NAME]: {
    defaultProvider: text,
    defaultModel: text,
    defaultThinkingLevel: oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    enabledModels: { type: "stringList" },
    theme: { type: "fileName" },
    hideThinkingBlock: flag,
    quietStartup: { type: "anyOf", of: [flag, oneOf(["header"])] },
    collapseChangelog: flag,
    doubleEscapeAction: oneOf(["fork", "tree", "none"]),
    treeFilterMode: oneOf(["default", "no-tools", "user-only", "labeled-only", "all"]),
    steeringMode: QUEUE_MODES,
    followUpMode: QUEUE_MODES,
  },
  "pi-subagents.json": jsonKeys([
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
  ]),
  "pi-style.json": jsonKeys(["style"]),
  "pi-notifications.json": jsonKeys(["channel", "idleDelayMs", "dialogDelayMs"]),
  "pi-session-limits.json": jsonKeys(["softRatio", "hardRatio", "softTokens", "hardTokens"]),
};

export const BUILT_IN_EXTENSION_FILES = Object.keys(BUILT_IN_WRITE_BACK).filter(
  (name) => name !== SETTINGS_FILE_NAME,
);

export const writeBackFileProblem = (name: string) => {
  if (NEVER_WRITTEN_FILES.includes(name)) {
    return "is never written back to the host";
  }

  return name === SETTINGS_FILE_NAME || EXTENSION_FILE.test(name)
    ? undefined
    : `must be ${SETTINGS_FILE_NAME} or a pi-<name>.json file of lowercase letters, digits and dashes`;
};

export const isNeverWritten = (file: string, key: string) => NEVER_WRITTEN_KEYS[file]?.includes(key) === true;

const holdsJson = (spec: ValueSpec): boolean =>
  spec.type === "json" || (spec.type === "anyOf" && spec.of.some(holdsJson));

const PATH_KEYS: Readonly<Record<string, readonly string[]>> = { [SETTINGS_FILE_NAME]: ["theme"] };

export const valueSpecProblem = (file: string, key: string, spec: ValueSpec) => {
  if (PATH_KEYS[file]?.includes(key) === true && spec.type !== "fileName") {
    return "must use type fileName, since host pi turns it into a path";
  }

  return file === SETTINGS_FILE_NAME && holdsJson(spec)
    ? `uses type json, which only a pi-<name>.json file may use`
    : undefined;
};

const keyAllowed =
  (file: string) =>
  ([key, spec]: [string, ValueSpec]) =>
    !isNeverWritten(file, key) && valueSpecProblem(file, key, spec) === undefined;

export const withinCeiling = (table: WriteBackTable): WriteBackTable =>
  Object.fromEntries(
    Object.entries(table)
      .filter(([file]) => writeBackFileProblem(file) === undefined)
      .map(([file, keys]) => [file, Object.fromEntries(Object.entries(keys).filter(keyAllowed(file)))]),
  );
