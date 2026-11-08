import { isAbsolute } from "node:path";
import {
  isJsonObject,
  isSecretName,
  LAUNCHER_SET_VARIABLES,
  LauncherError,
  PLACEHOLDER_PREFIX,
} from "../shared/index.ts";
import { getPath } from "./dotted.ts";
import { isLoopbackName, SECRET_MARKER, TLS_PORT } from "./egress-entry.ts";
import type { LayerConfig } from "./types.ts";

type Check = (value: string) => string | undefined;

type ObjectCheck = (value: Record<string, unknown>) => string | undefined;

type ListCheck = (value: unknown[]) => string | undefined;

interface ObjectSpec {
  type: "object";
  properties: Record<string, Spec>;
  required?: readonly string[];
  check?: ObjectCheck;
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

const HOST = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$/;

const MAX_PORT = 65535;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HEADER = /^[A-Za-z0-9-]+$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const HOST_NAME = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

const HOST_PATTERN = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

const IP_LITERAL = /^[0-9.]+$|:/;

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

const portOf = (value: string) => Number(value.split(":")[1] ?? TLS_PORT);

const host: Check = (value) => {
  if (!HOST.test(value)) {
    return `${value} is not a host name or host:port`;
  }

  const port = portOf(value);

  return port >= 1 && port <= MAX_PORT ? undefined : `${value} has a port outside 1-${MAX_PORT}`;
};

const variable: Check = (value) =>
  VARIABLE.test(value) ? undefined : `${value} is not an environment variable name`;

const launcherSet: Check = (value) =>
  LAUNCHER_SET_VARIABLES.includes(value) ? `${value} is set by the launcher and is not forwarded` : undefined;

const forwardableVariable: Check = (value) =>
  variable(value) ??
  launcherSet(value) ??
  (isSecretName(value) ? `${value} looks like a secret and stays on the host` : undefined);

const absolutePath: Check = (value) =>
  value.startsWith("/") || value === "~" || value.startsWith("~/")
    ? undefined
    : `${value} must be an absolute path or start with ~/`;

const repoPath: Check = (value) =>
  value !== "" && !isAbsolute(value) && !value.split("/").includes("..")
    ? undefined
    : `${value} must be a relative path inside the repository`;

const homeSegments = (value: string) => value.slice(2).replace(/\/$/, "").split("/");

const sharedCache: Check = (value) => {
  if (!value.startsWith("~/")) {
    return `${value} must start with ~/`;
  }

  const segments = homeSegments(value);

  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${value} must name a directory below ~ without empty, . or .. segments`;
  }

  const path = segments.join("/");
  const privateDir = PRIVATE_HOME_PATHS.find((dir) => path === dir || path.startsWith(`${dir}/`));

  return privateDir === undefined ? undefined : `${value} must not be or lie under ~/${privateDir}`;
};

const httpsUrl: Check = (value) =>
  URL.canParse(value) && new URL(value).protocol === "https:" ? undefined : "must be an https URL";

const header: Check = (value) => (HEADER.test(value) ? undefined : "must be a header name");

const digest: Check = (value) => (DIGEST.test(value) ? undefined : "must look like sha256:<64 hex digits>");

const hostName: Check = (value) =>
  HOST_NAME.test(value) && !IP_LITERAL.test(value) ? undefined : "must be a host name";

const hostPattern: Check = (value) =>
  HOST_PATTERN.test(value) ? undefined : "must be a host name or *.domain";

const quietHost: Check = (value) =>
  HOST.test(value) && portOf(value) >= 1 && portOf(value) <= MAX_PORT
    ? undefined
    : "must be a host name or host:port";

const privateHost: Check = (value) => {
  if (!HOST_PATTERN.test(value) || IP_LITERAL.test(value)) {
    return "must be a host name or *.domain, not an IP address";
  }

  return isLoopbackName(value) ? "must not name loopback" : undefined;
};

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

const quietAbsolutePath: Check = (value) =>
  absolutePath(value) === undefined ? undefined : "must be an absolute path or start with ~/";

const orgFile: Check = (value) => (isAbsolute(value) ? undefined : "must be an absolute path");

const aptPackage: Check = (value) => (APT_PACKAGE.test(value) ? undefined : "must be a package name");

const npmPackage: Check = (value) =>
  NPM_PACKAGE.test(value) ? undefined : "must be an npm name@version, no URL, path or git source";

const notEmptyList: ListCheck = (value) => (value.length === 0 ? "must not be empty" : undefined);

const distinctCaches: ListCheck = (value) => {
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

const ruleMode: ObjectCheck = (value) => {
  if (value.placeholder === undefined && value.header === undefined) {
    return "needs a placeholder or a header";
  }

  return value.template !== undefined && value.header === undefined ? "template needs a header" : undefined;
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
    env: shape({ env: text(variable) }, ["env"]),
    file: shape({ file: text(quietAbsolutePath), pointer: text(jsonPointer) }, ["file", "pointer"]),
    command: shape(
      { command: { type: "array", items: text(nonEmpty), check: notEmptyList }, ttlSeconds: positive },
      ["command"],
    ),
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
    transform: choice(["urlUserinfoBase64"]),
    secret: SECRET_REF,
  },
};

const EXTRA_CA: Spec = {
  type: "keyed",
  variants: {
    file: shape({ file: text(quietAbsolutePath) }, ["file"]),
    hostStore: shape({ hostStore: { type: "true" } }, ["hostStore"]),
  },
};

const LAYER_SPEC: ObjectSpec = {
  type: "object",
  properties: {
    $schema: text(),
    fallback: choice(["refuse", "host"]),
    image: shape({
      reference: text(nonEmpty),
      digest: text(digest),
      packages: list(aptPackage),
      npmGlobal: list(npmPackage),
      dockerfile: text(quietAbsolutePath),
    }),
    credentials: shape({
      rules: { type: "array", items: CREDENTIAL_RULE, check: uniqueIds },
      derive: shape({ enabled: flag, hosts: list(hostPattern) }),
      vault: shape({ enabled: flag }),
    }),
    egress: shape({
      allow: list(host),
      deny: list(quietHost),
      privateHosts: list(privateHost),
      parentProxy: choice(["env", "none"]),
      grants: flag,
    }),
    tls: shape({ extraCa: { type: "array", items: EXTRA_CA } }),
    workspaceRoots: {
      type: "object",
      required: ["roots", "outside"],
      properties: { roots: list(absolutePath), outside: choice(["refuse", "warn"]) },
    },
    mounts: {
      type: "object",
      properties: {
        extraReadOnly: list(absolutePath),
        cacheVolumes: list(repoPath),
        sharedCaches: { type: "array", items: text(sharedCache), check: distinctCaches },
        autoNodeModules: flag,
      },
    },
    env: { type: "object", properties: { allow: list(forwardableVariable) } },
    resources: { type: "object", properties: { cpus: positive, memoryGiB: positive } },
    sessions: shape({ host: flag }),
    org: text(orgFile),
  },
};

const joinPath = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

const PROJECT_KEYS = [
  "mounts.cacheVolumes",
  "mounts.autoNodeModules",
  "resources.cpus",
  "resources.memoryGiB",
];

const setKeys = (value: unknown, prefix: string): string[] =>
  isJsonObject(value)
    ? Object.entries(value).flatMap(([key, child]) => {
        const path = joinPath(prefix, key);

        return isJsonObject(child) ? setKeys(child, path) : [path];
      })
    : [];

export const projectKeyRefusal = (value: unknown, file?: string) => {
  const refused = setKeys(value, "").find((key) => key !== "$schema" && !PROJECT_KEYS.includes(key));

  if (refused === undefined) {
    return undefined;
  }

  const where = file === undefined ? "" : ` (${file})`;
  const from = file === undefined ? "" : ` from ${file}`;

  return new LauncherError(
    `project: ${refused} may not be set by a project config${where}`,
    `remove ${refused}${from}; a project config may set only ${PROJECT_KEYS.join(", ")}`,
  );
};

const ORG_KEY_LAYERS = ["policy", "user"];

const at = (path: string, problem: string | undefined): Problem | undefined =>
  problem === undefined ? undefined : { path, problem };

const firstProblem = (problems: Array<() => Problem | undefined>) =>
  problems.reduce<Problem | undefined>((found, next) => found ?? next(), undefined);

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
    return at(path, stringProblem(spec, value));
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

const misplacedOrg = (value: unknown, layerName: string) =>
  getPath(value, "org") !== undefined && !ORG_KEY_LAYERS.includes(layerName)
    ? new LauncherError(`${layerName}: org may only be set by the policy or user config`)
    : undefined;

export const validateLayer = (value: unknown, layerName: string): LayerConfig => {
  const found = problemOf(LAYER_SPEC, value, "");

  if (found !== undefined) {
    throw new LauncherError(
      found.path === "" ? `${layerName}: ${found.problem}` : `${layerName}: ${found.path} ${found.problem}`,
    );
  }

  const misplaced = layerName === "project" ? projectKeyRefusal(value) : misplacedOrg(value, layerName);

  if (misplaced !== undefined) {
    throw misplaced;
  }

  return value as LayerConfig;
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
