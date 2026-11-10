import {
  isJsonObject,
  isLauncherSetVariable,
  isSecretName,
  isToolConfigKey,
  LauncherError,
  PLACEHOLDER_PREFIX,
  TOOL_CONFIG_FORMATS,
  type ToolConfigFormat,
} from "../shared/index.ts";
import { parseHostEntry, SECRET_MARKER } from "./egress-entry.ts";
import { EGRESS_PRESETS } from "./egress-presets.ts";
import { FALLBACKS, type LayerConfig, PARENT_PROXIES } from "./types.ts";

type Check = (value: string) => string | undefined;

type ObjectCheck = (value: Record<string, unknown>) => string | undefined;

type ListCheck = (value: unknown[]) => string | undefined;

interface ObjectSpec {
  type: "object";
  properties: Record<string, Spec>;
  required?: readonly string[];
  check?: ObjectCheck;
  atomic?: true;
}

type Spec =
  | { type: "string"; check?: Check; values?: readonly string[] }
  | { type: "number"; exclusiveMinimum: number; maximum?: number; integer?: boolean }
  | { type: "true" }
  | { type: "boolean" }
  | { type: "array"; items: Spec; check?: ListCheck }
  | ObjectSpec
  | { type: "keyed"; variants: Record<string, ObjectSpec> };

interface Problem {
  path: string;
  problem: string;
}

const MAX_PORT = 65535;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HEADER = /^[A-Za-z0-9-]+$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

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

const shape = (properties: Record<string, Spec>, required?: readonly string[]): ObjectSpec => ({
  type: "object",
  properties,
  required,
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
    file: shape({ file: text(absolutePath) }, ["file"]),
    hostStore: shape({ hostStore: { type: "true" } }, ["hostStore"]),
  },
};

const LAYER_SPEC: ObjectSpec = {
  type: "object",
  properties: {
    $schema: text(),
    fallback: choice(FALLBACKS),
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
    egress: shape({
      allow: list(egressEntry),
      presets: { type: "array", items: choice(Object.keys(EGRESS_PRESETS)) },
      deny: list(egressEntry),
      privateHosts: list(hostPattern),
      parentProxy: choice(PARENT_PROXIES),
      grants: flag,
    }),
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
    sessions: shape({ host: flag }),
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
  /^(fallback|egress\.presets\[\d+\]|image\.(dockerfile|packages\[\d+\])|tls\.extraCa\[\d+\]\.file|workspaceRoots\.roots\[\d+\]|mounts\.sharedCaches\[\d+\]|env\.allow\[\d+\])$/;

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

const numberProblem = (
  spec: { exclusiveMinimum: number; maximum?: number; integer?: boolean },
  value: unknown,
) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "must be a number";
  }

  if (spec.integer === true && !Number.isInteger(value)) {
    return "must be a whole number";
  }

  if (spec.maximum !== undefined && value > spec.maximum) {
    return `must be at most ${spec.maximum}`;
  }

  return value <= spec.exclusiveMinimum ? `must be greater than ${spec.exclusiveMinimum}` : undefined;
};

const objectProblem = (spec: ObjectSpec, value: unknown, path: string): Problem | undefined => {
  if (!isJsonObject(value)) {
    return { path, problem: path === "" ? "must be a JSON object" : "must be an object" };
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

const keyedProblem = (variants: Record<string, ObjectSpec>, value: unknown, path: string) => {
  if (!isJsonObject(value)) {
    return { path, problem: "must be an object" };
  }

  const names = Object.keys(variants);
  const chosen = names.find((name) => Object.hasOwn(value, name));

  return chosen === undefined
    ? { path, problem: `must set one of ${names.join(", ")}` }
    : objectProblem(variants[chosen], value, path);
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

  return spec.type === "keyed" ? keyedProblem(spec.variants, value, path) : objectProblem(spec, value, path);
};

const normalized = (layer: LayerConfig): LayerConfig => {
  const caches = layer.mounts?.sharedCaches;

  return caches === undefined
    ? layer
    : { ...layer, mounts: { ...layer.mounts, sharedCaches: caches.map(withoutTrailingSlash) } };
};

export const validateLayer = (value: unknown, layerName: string): LayerConfig => {
  const found = problemOf(LAYER_SPEC, value, "");

  if (found !== undefined) {
    throw new LauncherError(
      found.path === "" ? `${layerName}: ${found.problem}` : `${layerName}: ${found.path} ${found.problem}`,
    );
  }

  return normalized(value as LayerConfig);
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

export const layerKeys = () => keysOf(LAYER_SPEC, "");

const leavesOf = (spec: Spec, path: string): string[] =>
  spec.type === "object" && spec.atomic !== true
    ? Object.entries(spec.properties).flatMap(([key, child]) => leavesOf(child, joinPath(path, key)))
    : [path];

export const leafKeys = () => leavesOf(LAYER_SPEC, "").filter((key) => key !== "$schema");
