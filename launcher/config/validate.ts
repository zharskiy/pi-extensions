import {
  errorMessage,
  isJsonObject,
  isLauncherSetVariable,
  isNeverWritten,
  isSecretName,
  isToolConfigKey,
  LauncherError,
  MAX_WRITE_BACK_CHARS,
  PLACEHOLDER_PREFIX,
  printable,
  TOOL_CONFIG_FORMATS,
  type ToolConfigFormat,
  type ValueType,
  valueSpecProblem,
  writeBackFileProblem,
} from "../shared/index.ts";
import { parseHostEntry, SECRET_MARKER } from "./egress-entry.ts";
import type { UserConfig } from "./types.ts";
import { builtInKeysOf } from "./write-back.ts";

type Check = (value: string) => string | undefined;

type ObjectCheck = (value: Record<string, unknown>) => string | undefined;

type ListCheck = (value: unknown[]) => string | undefined;

interface ObjectSpec {
  type: "object";
  properties: Record<string, Spec>;
  required?: readonly string[];
  check?: ObjectCheck;
  atomic?: true;
  removed?: Record<string, string>;
}

interface NumberSpec {
  type: "number";
  exclusiveMinimum?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
}

type Spec =
  | { type: "string"; check?: Check; values?: readonly string[] }
  | NumberSpec
  | { type: "true" }
  | { type: "boolean" }
  | { type: "array"; items: Spec; check?: ListCheck }
  | ObjectSpec
  | { type: "keyed"; variants: Record<string, ObjectSpec>; removed?: Record<string, string> }
  | { type: "custom"; problem: (value: unknown, path: string) => Problem | undefined };

interface Problem {
  path: string;
  problem: string;
}

export const MAX_PORT = 65535;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HEADER = /^[A-Za-z0-9-]+$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const FINGERPRINT = /^([0-9A-Fa-f]:?){63}[0-9A-Fa-f]$/;

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const JSON_POINTER = /^(\/([^~/]|~[01])*)+$/;

const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

const PRIVATE_HOME_PATHS = [
  ".pi",
  ".ssh",
  ".gnupg",
  ".aws",
  ".docker",
  ".colima",
  ".kube",
  ".config",
  ".local/bin",
];

const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.+-]*$/;

const nonEmpty: Check = (value) => (value.trim() === "" ? "must not be empty" : undefined);

const hostCheck =
  (wildcard: boolean, port: boolean): Check =>
  (value) => {
    const entry = parseHostEntry(value, { wildcard, port });

    return "problem" in entry ? entry.problem : undefined;
  };

const egressEntry = hostCheck(true, true);

const hostName = hostCheck(false, false);

const hostPattern = hostCheck(true, false);

const variable: Check = (value) => (VARIABLE.test(value) ? undefined : "is not an environment variable name");

const launcherSet: Check = (value) =>
  isLauncherSetVariable(value) ? "is set by the launcher and is not forwarded" : undefined;

const forwardableVariable: Check = (value) =>
  variable(value) ??
  launcherSet(value) ??
  (isSecretName(value) ? "looks like a secret and stays on the host" : undefined);

const absolutePath: Check = (value) =>
  value.startsWith("/") || value === "~" || value.startsWith("~/")
    ? undefined
    : "must be an absolute path or start with ~/";

const withoutTrailingSlash = (value: string) => value.replace(/\/$/, "");

const homeSegments = (value: string) => withoutTrailingSlash(value.slice(2)).split("/");

const sharedCache: Check = (value) => {
  if (!value.startsWith("~/")) {
    return "must start with ~/";
  }

  const segments = homeSegments(value);

  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must name a directory below ~ without empty, . or .. segments";
  }

  const path = segments.join("/");
  const privateDir = PRIVATE_HOME_PATHS.find((dir) => path === dir || path.startsWith(`${dir}/`));

  return privateDir === undefined ? undefined : `must not be or lie under ~/${privateDir}`;
};

const httpsUrl: Check = (value) =>
  URL.canParse(value) && new URL(value).protocol === "https:" ? undefined : "must be an https URL";

const header: Check = (value) => (HEADER.test(value) ? undefined : "must be a header name");

const digest: Check = (value) => (DIGEST.test(value) ? undefined : "must look like sha256:<64 hex digits>");

const fingerprint: Check = (value) =>
  FINGERPRINT.test(value) ? undefined : "must be 64 hex digits, colons optional";

const ruleId: Check = (value) =>
  RULE_ID.test(value) ? undefined : "must be letters, digits, dot, dash or underscore";

const pathPrefix: Check = (value) => (value.startsWith("/") ? undefined : "must start with /");

const placeholder: Check = (value) =>
  value.startsWith(PLACEHOLDER_PREFIX) && value.length > PLACEHOLDER_PREFIX.length
    ? undefined
    : `must start with ${PLACEHOLDER_PREFIX}`;

const template: Check = (value) =>
  value.includes(SECRET_MARKER) ? undefined : `must contain ${SECRET_MARKER}`;

const jsonPointer: Check = (value) => (JSON_POINTER.test(value) ? undefined : "must be a JSON pointer");

const aptPackage: Check = (value) => (APT_PACKAGE.test(value) ? undefined : "must be a package name");

const npmPackage: Check = (value) =>
  NPM_PACKAGE.test(value) ? undefined : "must be an npm name@version, no URL, path or git source";

const notEmptyList: ListCheck = (value) => (value.length === 0 ? "must not be empty" : undefined);

const distinctHomePaths: ListCheck = (value) => {
  const paths = value.map((item) => homeSegments(String(item)).join("/"));
  const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);

  if (duplicate !== undefined) {
    return `lists ~/${duplicate} twice`;
  }

  const nested = paths.find((path) => paths.some((other) => path.startsWith(`${other}/`)));

  return nested === undefined ? undefined : `lists ~/${nested} inside another entry`;
};

const uniqueIds: ListCheck = (value) => {
  const ids = value.map((item) => (isJsonObject(item) ? item.id : undefined));

  return ids.some((id, index) => ids.indexOf(id) !== index) ? "has a duplicate id" : undefined;
};

const pinnedReference: ObjectCheck = (value) =>
  (value.reference === undefined) !== (value.digest === undefined)
    ? "sets reference and digest only together: the image is pulled by its digest, or built here without either"
    : undefined;

const ruleMode: ObjectCheck = (value) => {
  if (value.placeholder === undefined && value.header === undefined) {
    return "needs a placeholder or a header";
  }

  return value.template !== undefined && value.header === undefined ? "template needs a header" : undefined;
};

const oneUrlPart: ObjectCheck = (value) =>
  value.urlPassword !== undefined && value.urlUsername !== undefined
    ? "sets both urlPassword and urlUsername"
    : undefined;

const fileSecretMode: ObjectCheck = (value) => {
  const selected = [value.format, value.key, value.urlPassword, value.urlUsername].some(
    (field) => field !== undefined,
  );

  if (value.pointer !== undefined) {
    return selected ? "sets pointer together with format, key, urlPassword or urlUsername" : undefined;
  }

  const both = oneUrlPart(value);

  if (both !== undefined) {
    return both;
  }

  if (value.format === undefined || value.key === undefined) {
    return "needs a pointer, or a format and a key";
  }

  return isToolConfigKey(value.format as ToolConfigFormat, String(value.key))
    ? undefined
    : `key does not fit the ${String(value.format)} format`;
};

const text = (check?: Check): Spec => ({ type: "string", check });

const choice = (values: readonly string[]): Spec => ({ type: "string", values });

const list = (check?: Check): Spec => ({ type: "array", items: text(check) });

const positive: Spec = { type: "number", exclusiveMinimum: 0 };

const port: Spec = { type: "number", exclusiveMinimum: 0, maximum: MAX_PORT, integer: true };

const flag: Spec = { type: "boolean" };

const shape = (
  properties: Record<string, Spec>,
  required?: readonly string[],
  removed?: Record<string, string>,
): ObjectSpec => ({
  type: "object",
  properties,
  required,
  removed,
});

const SECRET_REF: Spec = {
  type: "keyed",
  variants: {
    env: {
      ...shape({ env: text(variable), urlPassword: { type: "true" }, urlUsername: { type: "true" } }, [
        "env",
      ]),
      check: oneUrlPart,
    },
    file: {
      ...shape(
        {
          file: text(absolutePath),
          pointer: text(jsonPointer),
          format: choice(TOOL_CONFIG_FORMATS),
          key: text(nonEmpty),
          urlPassword: { type: "true" },
          urlUsername: { type: "true" },
        },
        ["file"],
      ),
      check: fileSecretMode,
    },
    command: shape({ command: { type: "array", items: text(nonEmpty), check: notEmptyList } }, ["command"]),
    piAuth: shape({ piAuth: text(nonEmpty), bearer: flag }, ["piAuth"]),
    mcpOAuth: shape({ mcpOAuth: shape({ server: text(nonEmpty), url: text(httpsUrl) }, ["server", "url"]) }, [
      "mcpOAuth",
    ]),
  },
};

const CREDENTIAL_RULE: ObjectSpec = {
  type: "object",
  required: ["id", "host", "secret"],
  check: ruleMode,
  properties: {
    id: text(ruleId),
    host: text(hostName),
    port,
    pathPrefix: text(pathPrefix),
    placeholder: text(placeholder),
    header: text(header),
    template: text(template),
    secret: SECRET_REF,
  },
};

const EXTRA_CA: Spec = {
  type: "keyed",
  variants: {
    sha256: shape({ sha256: text(fingerprint) }, ["sha256"]),
    file: shape({ file: text(absolutePath) }, ["file"]),
  },
  removed: { hostStore: "was removed; run pi sandbox doctor to get the sha256 of your network's CA" },
};

const WRITE_BACK_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const MAX_KEY_CHARS = 100;

const keyPath = (prefix: string, key: string) => `${prefix}[${JSON.stringify(key)}]`;

const anyNumber: Spec = { type: "number" };

const wholeNumber: Spec = { type: "number", integer: true };

const orderedRange: ObjectCheck = (value) =>
  typeof value.min === "number" && typeof value.max === "number" && value.min > value.max
    ? "sets min above max"
    : undefined;

const scalarProblem = (value: unknown, path: string): Problem | undefined => {
  if (typeof value === "string") {
    return at(
      path,
      value.length > MAX_WRITE_BACK_CHARS ? `must be at most ${MAX_WRITE_BACK_CHARS} characters` : undefined,
    );
  }

  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    ? undefined
    : { path, problem: "must be a string, a number or true or false" };
};

const typed = (properties: Record<string, Spec>, required: readonly string[] = []) =>
  shape({ type: text(), ...properties }, ["type", ...required]);

export const MAX_ANY_OF_DEPTH = 4;

const VALUE_SPECS: Record<Exclude<ValueType, "anyOf">, ObjectSpec> = {
  string: typed({ maxLength: { type: "number", minimum: 1, maximum: MAX_WRITE_BACK_CHARS, integer: true } }),
  boolean: typed({}),
  integer: { ...typed({ min: wholeNumber, max: wholeNumber }), check: orderedRange },
  number: { ...typed({ min: anyNumber, max: anyNumber }), check: orderedRange },
  enum: typed(
    { values: { type: "array", items: { type: "custom", problem: scalarProblem }, check: notEmptyList } },
    ["values"],
  ),
  stringList: typed({ maxItems: { type: "number", minimum: 1, integer: true } }),
  fileName: typed({}),
  json: typed({}),
};

const anyOfSpec = (depth: number): ObjectSpec =>
  typed(
    {
      of: {
        type: "array",
        items: { type: "custom", problem: (value, path) => valueSpecAt(value, path, depth + 1) },
        check: notEmptyList,
      },
    },
    ["of"],
  );

const VALUE_TYPES: readonly ValueType[] = [...(Object.keys(VALUE_SPECS) as ValueType[]), "anyOf"];

const isValueType = (value: unknown): value is ValueType => VALUE_TYPES.includes(value as ValueType);

const valueSpecAt = (value: unknown, path: string, depth = 1): Problem | undefined => {
  if (!isJsonObject(value)) {
    return { path, problem: "must be an object" };
  }

  if (!isValueType(value.type)) {
    return { path: joinPath(path, "type"), problem: `must be one of ${VALUE_TYPES.join(", ")}` };
  }

  if (value.type !== "anyOf") {
    return objectProblem(VALUE_SPECS[value.type], value, path);
  }

  return depth > MAX_ANY_OF_DEPTH
    ? { path, problem: `nests anyOf more than ${MAX_ANY_OF_DEPTH} levels deep` }
    : objectProblem(anyOfSpec(depth), value, path);
};

const excludedKeysAt = (file: string, keys: unknown, path: string): Problem | undefined => {
  const builtIn = builtInKeysOf(file);

  if (builtIn === undefined) {
    return { path, problem: "is not a file of the built-in write-back list" };
  }

  const listed = problemOf(list(), keys, path);

  if (listed !== undefined) {
    return listed;
  }

  return firstProblem(
    (keys as string[]).map(
      (key, index) => () =>
        Object.hasOwn(builtIn, key)
          ? undefined
          : {
              path: `${path}[${index}]`,
              problem: `${shown(key)} is not a built-in write-back key of ${file}`,
            },
    ),
  );
};

const excludeAt = (value: unknown, path: string): Problem | undefined =>
  isJsonObject(value)
    ? firstProblem(
        Object.entries(value).map(
          ([file, keys]) =>
            () =>
              excludedKeysAt(file, keys, keyPath(path, file)),
        ),
      )
    : { path, problem: "must be an object" };

const addedKeyProblem = (file: string, key: string) => {
  if (!WRITE_BACK_KEY.test(key) || key.length > MAX_KEY_CHARS) {
    return "must be a key name of letters, digits, dash or underscore, starting with a letter";
  }

  return isNeverWritten(file, key) ? `is host-owned and never written back to the host` : undefined;
};

const addedKeyAt = (file: string, key: string, spec: unknown, path: string) =>
  firstProblem([
    () => at(path, addedKeyProblem(file, key)),
    () => valueSpecAt(spec, path),
    () => at(path, valueSpecProblem(file, key, spec as never)),
  ]);

const addedFileAt = (file: string, keys: unknown, path: string): Problem | undefined => {
  const fileProblem = writeBackFileProblem(file);

  if (fileProblem !== undefined) {
    return { path, problem: fileProblem };
  }

  return isJsonObject(keys)
    ? firstProblem(
        Object.entries(keys).map(
          ([key, spec]) =>
            () =>
              addedKeyAt(file, key, spec, keyPath(path, key)),
        ),
      )
    : { path, problem: "must be an object" };
};

const addAt = (value: unknown, path: string): Problem | undefined =>
  isJsonObject(value)
    ? firstProblem(
        Object.entries(value).map(
          ([file, keys]) =>
            () =>
              addedFileAt(file, keys, keyPath(path, file)),
        ),
      )
    : { path, problem: "must be an object" };

const excludedAndAdded: ObjectCheck = (value) => {
  const exclude = (value.exclude ?? {}) as Record<string, string[]>;
  const add = (value.add ?? {}) as Record<string, Record<string, unknown>>;
  const clash = Object.entries(exclude)
    .flatMap(([file, keys]) => keys.map((key) => [file, key] as const))
    .find(([file, key]) => Object.hasOwn(add, file) && Object.hasOwn(add[file], key));

  return clash === undefined ? undefined : `excludes and adds ${clash[1]} of ${clash[0]}`;
};

const WRITE_BACK: ObjectSpec = {
  ...shape({
    enabled: flag,
    exclude: { type: "custom", problem: excludeAt },
    add: { type: "custom", problem: addAt },
  }),
  check: excludedAndAdded,
};

export const VM_BOUNDS = {
  cpus: { min: 1, max: 64 },
  memoryGiB: { min: 2, max: 256 },
  diskGiB: { min: 20, max: 2048 },
} as const;

const vmSize = (minimum: number, maximum: number): Spec => ({
  type: "number",
  minimum,
  maximum,
  integer: true,
});

const RESOURCE_KEYS = ["cpus", "memoryGiB"] as const;

const resourcesWithinVm: ObjectCheck = (value) => {
  const resources = (value.resources ?? {}) as Record<string, number | undefined>;
  const vm = (value.vm ?? {}) as Record<string, number | undefined>;
  const larger = RESOURCE_KEYS.find((key) => (resources[key] ?? 0) > (vm[key] ?? Number.POSITIVE_INFINITY));

  return larger === undefined
    ? undefined
    : `resources.${larger} ${resources[larger]} is larger than vm.${larger} ${vm[larger]}; resources limits one container inside the VM`;
};

const CONFIG_SPEC: ObjectSpec = {
  type: "object",
  check: resourcesWithinVm,
  removed: { fallback: "was removed; --no-sandbox is always available" },
  properties: {
    $schema: text(),
    image: {
      ...shape({
        reference: text(nonEmpty),
        digest: text(digest),
        packages: list(aptPackage),
        npmGlobal: list(npmPackage),
        dockerfile: text(absolutePath),
      }),
      check: pinnedReference,
    },
    credentials: shape({
      rules: { type: "array", items: CREDENTIAL_RULE, check: uniqueIds },
      derive: shape({ enabled: flag, hosts: list(hostPattern) }),
    }),
    egress: shape(
      {
        allow: list(egressEntry),
        deny: list(egressEntry),
        privateHosts: list(hostPattern),
      },
      undefined,
      {
        presets: "was removed; list the hosts in egress.allow, see REMOVED-DEFAULTS.md",
        grants: "was removed; grants are always on",
        parentProxy: "was removed; the parent proxy is always taken from the environment",
      },
    ),
    tls: shape({ extraCa: { type: "array", items: EXTRA_CA } }),
    workspaceRoots: {
      type: "object",
      atomic: true,
      required: ["roots"],
      properties: { roots: list(absolutePath) },
    },
    mounts: {
      type: "object",
      properties: {
        sharedCaches: { type: "array", items: text(sharedCache), check: distinctHomePaths },
        autoOverlays: flag,
      },
    },
    env: { type: "object", properties: { allow: list(forwardableVariable) } },
    resources: { type: "object", properties: { cpus: positive, memoryGiB: positive } },
    vm: shape({
      cpus: vmSize(VM_BOUNDS.cpus.min, VM_BOUNDS.cpus.max),
      memoryGiB: vmSize(VM_BOUNDS.memoryGiB.min, VM_BOUNDS.memoryGiB.max),
      diskGiB: vmSize(VM_BOUNDS.diskGiB.min, VM_BOUNDS.diskGiB.max),
    }),
    sessions: shape({ host: flag }),
    terminal: shape({ clipboard: flag }),
    writeBack: WRITE_BACK,
  },
};

const joinPath = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

const at = (path: string, problem: string | undefined): Problem | undefined =>
  problem === undefined ? undefined : { path, problem };

const firstProblem = (problems: Array<() => Problem | undefined>) =>
  problems.reduce<Problem | undefined>((found, next) => found ?? next(), undefined);

const MAX_SHOWN = 200;

const PRINTABLE = /^[\x20-\x7e]*$/;

const NAMED_PATHS =
  /^(image\.(dockerfile|packages\[\d+\])|tls\.extraCa\[\d+\]\.file|workspaceRoots\.roots\[\d+\]|mounts\.sharedCaches\[\d+\]|env\.allow\[\d+\])$/;

const shown = (value: string) => {
  const cut = value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}...` : value;

  return PRINTABLE.test(cut) && cut.trim() !== "" ? cut : JSON.stringify(cut);
};

const named = (path: string, value: unknown, problem: string | undefined) =>
  problem === undefined || typeof value !== "string" || !NAMED_PATHS.test(path)
    ? problem
    : `${shown(value)} ${problem}`;

const stringProblem = (spec: { check?: Check; values?: readonly string[] }, value: unknown) => {
  if (typeof value !== "string") {
    return "must be a string";
  }

  if (spec.values !== undefined && !spec.values.includes(value)) {
    return `must be one of ${spec.values.join(", ")}`;
  }

  return spec.check?.(value);
};

const numberProblem = (spec: NumberSpec, value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "must be a number";
  }

  if (spec.integer === true && !Number.isInteger(value)) {
    return "must be a whole number";
  }

  if (spec.maximum !== undefined && value > spec.maximum) {
    return `must be at most ${spec.maximum}`;
  }

  if (spec.minimum !== undefined && value < spec.minimum) {
    return `must be at least ${spec.minimum}`;
  }

  return spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum
    ? `must be greater than ${spec.exclusiveMinimum}`
    : undefined;
};

const objectProblem = (spec: ObjectSpec, value: unknown, path: string): Problem | undefined => {
  if (!isJsonObject(value)) {
    return { path, problem: path === "" ? "must be a JSON object" : "must be an object" };
  }

  const removedKey = Object.entries(spec.removed ?? {}).find(([name]) => Object.hasOwn(value, name));

  if (removedKey !== undefined) {
    return { path: joinPath(path, removedKey[0]), problem: removedKey[1] };
  }

  const unknownKey = Object.keys(value).find((key) => !Object.hasOwn(spec.properties, key));
  const missingKey = (spec.required ?? []).find((key) => value[key] === undefined);

  return firstProblem([
    () =>
      unknownKey === undefined
        ? undefined
        : { path: joinPath(path, unknownKey), problem: "is not a known key" },
    () =>
      missingKey === undefined ? undefined : { path: joinPath(path, missingKey), problem: "is required" },
    ...Object.entries(value).map(
      ([key, child]) =>
        () =>
          problemOf(spec.properties[key], child, joinPath(path, key)),
    ),
    () => at(path, spec.check?.(value)),
  ]);
};

const keyedProblem = (spec: Extract<Spec, { type: "keyed" }>, value: unknown, path: string) => {
  if (!isJsonObject(value)) {
    return { path, problem: "must be an object" };
  }

  const removed = Object.entries(spec.removed ?? {}).find(([name]) => Object.hasOwn(value, name));

  if (removed !== undefined) {
    return { path: joinPath(path, removed[0]), problem: removed[1] };
  }

  const names = Object.keys(spec.variants);
  const chosen = names.find((name) => Object.hasOwn(value, name));

  return chosen === undefined
    ? { path, problem: `must set one of ${names.join(", ")}` }
    : objectProblem(spec.variants[chosen], value, path);
};

const problemOf = (spec: Spec, value: unknown, path: string): Problem | undefined => {
  if (spec.type === "string") {
    return at(path, named(path, value, stringProblem(spec, value)));
  }

  if (spec.type === "number") {
    return at(path, numberProblem(spec, value));
  }

  if (spec.type === "true") {
    return at(path, value === true ? undefined : "must be true");
  }

  if (spec.type === "boolean") {
    return at(path, typeof value === "boolean" ? undefined : "must be true or false");
  }

  if (spec.type === "array") {
    return Array.isArray(value)
      ? firstProblem([
          ...value.map((item, index) => () => problemOf(spec.items, item, `${path}[${index}]`)),
          () => at(path, spec.check?.(value)),
        ])
      : { path, problem: "must be an array" };
  }

  if (spec.type === "custom") {
    return spec.problem(value, path);
  }

  return spec.type === "keyed" ? keyedProblem(spec, value, path) : objectProblem(spec, value, path);
};

const normalized = (config: UserConfig): UserConfig => {
  const caches = config.mounts?.sharedCaches;

  return caches === undefined
    ? config
    : { ...config, mounts: { ...config.mounts, sharedCaches: caches.map(withoutTrailingSlash) } };
};

export const validateConfig = (value: unknown): UserConfig => {
  const found = problemOf(CONFIG_SPEC, value, "");

  if (found !== undefined) {
    const message = found.path === "" ? found.problem : `${found.path} ${found.problem}`;

    throw new LauncherError(`config: ${printable(message)}`);
  }

  return normalized(value as UserConfig);
};

export const configProblem = (value: unknown) => {
  try {
    validateConfig(value);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const keysOf = (spec: Spec, path: string): string[] => {
  if (spec.type === "object") {
    return Object.entries(spec.properties).flatMap(([key, child]) => [
      joinPath(path, key),
      ...keysOf(child, joinPath(path, key)),
    ]);
  }

  if (spec.type === "keyed") {
    return [...new Set(Object.values(spec.variants).flatMap((variant) => keysOf(variant, path)))];
  }

  return spec.type === "array" ? keysOf(spec.items, `${path}[]`) : [];
};

export const configKeys = () => keysOf(CONFIG_SPEC, "");

const leavesOf = (spec: Spec, path: string): string[] =>
  spec.type === "object" && spec.atomic !== true
    ? Object.entries(spec.properties).flatMap(([key, child]) => leavesOf(child, joinPath(path, key)))
    : [path];

export const leafKeys = () => leavesOf(CONFIG_SPEC, "").filter((key) => key !== "$schema");
