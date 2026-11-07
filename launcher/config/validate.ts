import { isAbsolute } from "node:path";
import { BACKEND_NAMES, isSecretName, LauncherError } from "../shared/index.ts";
import { getPath, isRecord } from "./dotted.ts";
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

interface VariantsSpec {
  type: "variants";
  tag: string;
  variants: Record<string, ObjectSpec>;
  untagged?: ObjectSpec;
}

type Spec =
  | { type: "string"; check?: Check; values?: readonly string[] }
  | { type: "number"; exclusiveMinimum: number; maximum?: number; integer?: boolean }
  | { type: "true" }
  | { type: "boolean" }
  | { type: "array"; items: Spec; check?: ListCheck }
  | ObjectSpec
  | VariantsSpec
  | { type: "keyed"; variants: Record<string, ObjectSpec> }
  | { type: "either"; text: Spec; object: Spec };

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

const SHA256_HEX = /^[0-9a-f]{64}$/;

const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.+-]*$/;

const PLACEHOLDER_PREFIX = "pi-sandbox-";

const SECRET_MARKER = "{secret}";

const nonEmpty: Check = (value) => (value.trim() === "" ? "must not be empty" : undefined);

const portOf = (value: string) => Number(value.split(":")[1] ?? "443");

const host: Check = (value) => {
  if (!HOST.test(value)) {
    return `${value} is not a host name or host:port`;
  }

  const port = portOf(value);

  return port >= 1 && port <= MAX_PORT ? undefined : `${value} has a port outside 1-${MAX_PORT}`;
};

const variable: Check = (value) =>
  VARIABLE.test(value) ? undefined : `${value} is not an environment variable name`;

const forwardableVariable: Check = (value) =>
  variable(value) ?? (isSecretName(value) ? `${value} looks like a secret and stays on the host` : undefined);

const absolutePath: Check = (value) =>
  value.startsWith("/") || value === "~" || value.startsWith("~/")
    ? undefined
    : `${value} must be an absolute path or start with ~/`;

const repoPath: Check = (value) =>
  value !== "" && !isAbsolute(value) && !value.split("/").includes("..")
    ? undefined
    : `${value} must be a relative path inside the repository`;

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

const isLoopbackName = (value: string) => value === "localhost" || value.endsWith(".localhost");

const privateHost: Check = (value) => {
  if (!HOST_PATTERN.test(value) || IP_LITERAL.test(value)) {
    return "must be a host name or *.domain, not an IP address";
  }

  return isLoopbackName(value) ? "must not name loopback" : undefined;
};

const noProxyEntry: Check = (value) =>
  quietHost(value.startsWith(".") ? value.slice(1) : value) === undefined
    ? undefined
    : "must be a host name, .domain or *.domain";

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

const httpUrl: Check = (value) => {
  const url = URL.canParse(value) ? new URL(value) : undefined;

  if (url === undefined || url.protocol !== "http:") {
    return "must be an http URL";
  }

  return url.username === "" && url.password === "" ? undefined : "must not carry credentials";
};

const orgSource: Check = (value) =>
  quietAbsolutePath(value) === undefined || httpsUrl(value) === undefined
    ? undefined
    : "must be an absolute path or an https URL";

const sha256Text: Check = (value) => (SHA256_HEX.test(value) ? undefined : "must be 64 hex digits");

const aptPackage: Check = (value) => (APT_PACKAGE.test(value) ? undefined : "must be a package name");

const npmPackage: Check = (value) =>
  NPM_PACKAGE.test(value) ? undefined : "must be an npm name@version, no URL, path or git source";

const notEmptyList: ListCheck = (value) => (value.length === 0 ? "must not be empty" : undefined);

const uniqueIds: ListCheck = (value) => {
  const ids = value.map((item) => (isRecord(item) ? item.id : undefined));

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
    secret: SECRET_REF,
  },
};

const CREDENTIAL_EXTRAS: Record<string, Spec> = {
  rules: { type: "array", items: CREDENTIAL_RULE, check: uniqueIds },
  derive: shape({ enabled: flag, hosts: list(hostPattern) }),
};

const legacyCredentials = (properties: Record<string, Spec>, required: readonly string[]): ObjectSpec =>
  shape({ ...properties, ...CREDENTIAL_EXTRAS }, required);

const PARENT_PROXY: Spec = {
  type: "either",
  text: choice(["env", "none"]),
  object: shape({ url: text(httpUrl), noProxy: list(noProxyEntry), auth: SECRET_REF }, ["url"]),
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
    profile: choice(["enterprise", "team", "solo"]),
    backend: choice(["auto", ...BACKEND_NAMES]),
    fallback: choice(["refuse", "host"]),
    image: shape({
      reference: text(nonEmpty),
      digest: text(digest),
      packages: list(aptPackage),
      npmGlobal: list(npmPackage),
      dockerfile: text(quietAbsolutePath),
    }),
    gateway: {
      type: "object",
      required: ["url", "authHeader", "placeholder", "providers"],
      properties: {
        url: text(httpsUrl),
        authHeader: text(header),
        placeholder: text(nonEmpty),
        providers: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "apiKind"],
            properties: { id: text(nonEmpty), apiKind: text(nonEmpty) },
          },
        },
      },
    },
    credentials: {
      type: "variants",
      tag: "kind",
      untagged: shape(CREDENTIAL_EXTRAS),
      variants: {
        static: legacyCredentials(
          { kind: choice(["static"]), envVar: text(variable), keychainService: text(nonEmpty) },
          ["kind"],
        ),
        "host-pi-auth": legacyCredentials({ kind: choice(["host-pi-auth"]), authFile: text(absolutePath) }, [
          "kind",
        ]),
        sso: legacyCredentials({ kind: choice(["sso"]), command: list(nonEmpty) }, ["kind", "command"]),
      },
    },
    egress: shape({
      allow: list(host),
      mcpHosts: list(host),
      denyPrivateAddresses: { type: "true" },
      deny: list(quietHost),
      privateHosts: list(privateHost),
      parentProxy: PARENT_PROXY,
      grants: shape({ enabled: flag, maxHours: positive, permanent: flag }),
    }),
    tls: shape({ extraCa: { type: "array", items: EXTRA_CA } }),
    workspaceRoots: {
      type: "object",
      required: ["roots", "outside"],
      properties: { roots: list(absolutePath), outside: choice(["refuse", "warn"]) },
    },
    mounts: {
      type: "object",
      properties: { extraReadOnly: list(absolutePath), cacheVolumes: list(repoPath) },
    },
    env: { type: "object", properties: { allow: list(forwardableVariable) } },
    ssh: { type: "object", properties: { agent: { type: "boolean" } } },
    resources: { type: "object", properties: { cpus: positive, memoryGiB: positive } },
    org: shape({ source: text(orgSource), sha256: text(sha256Text), refreshHours: positive }, ["source"]),
  },
};

const PROJECT_REFUSED_KEYS = [
  "credentials.rules",
  "credentials.derive",
  "egress.deny",
  "egress.privateHosts",
  "egress.parentProxy",
  "egress.grants",
  "tls",
  "image.packages",
  "image.npmGlobal",
  "image.dockerfile",
  "org",
];

const ORG_KEY_LAYERS = ["policy", "user"];

const joinPath = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

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
  if (!isRecord(value)) {
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

const variantProblem = (spec: VariantsSpec, value: unknown, path: string): Problem | undefined => {
  if (!isRecord(value)) {
    return { path, problem: "must be an object" };
  }

  const names = Object.keys(spec.variants);
  const tag = value[spec.tag];

  if (tag === undefined && spec.untagged !== undefined) {
    return objectProblem(spec.untagged, value, path);
  }

  if (typeof tag !== "string" || !names.includes(tag)) {
    return { path: joinPath(path, spec.tag), problem: `must be one of ${names.join(", ")}` };
  }

  return objectProblem(spec.variants[tag], value, path);
};

const keyedProblem = (variants: Record<string, ObjectSpec>, value: unknown, path: string) => {
  if (!isRecord(value)) {
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

  if (spec.type === "keyed") {
    return keyedProblem(spec.variants, value, path);
  }

  if (spec.type === "either") {
    return problemOf(typeof value === "string" ? spec.text : spec.object, value, path);
  }

  return spec.type === "object" ? objectProblem(spec, value, path) : variantProblem(spec, value, path);
};

const layerKeyProblem = (value: unknown, layerName: string) => {
  const refused =
    layerName === "project"
      ? PROJECT_REFUSED_KEYS.find((key) => getPath(value, key) !== undefined)
      : undefined;

  if (refused !== undefined) {
    return `${layerName}: ${refused} may not be set by a project config`;
  }

  const misplacedOrg = getPath(value, "org") !== undefined && !ORG_KEY_LAYERS.includes(layerName);

  return misplacedOrg ? `${layerName}: org may only be set by the policy or user config` : undefined;
};

export const validateLayer = (value: unknown, layerName: string): LayerConfig => {
  const found = problemOf(LAYER_SPEC, value, "");

  if (found !== undefined) {
    throw new LauncherError(
      found.path === "" ? `${layerName}: ${found.problem}` : `${layerName}: ${found.path} ${found.problem}`,
    );
  }

  const misplaced = layerKeyProblem(value, layerName);

  if (misplaced !== undefined) {
    throw new LauncherError(misplaced);
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

  if (spec.type === "variants") {
    const variants = [
      ...Object.values(spec.variants),
      ...(spec.untagged === undefined ? [] : [spec.untagged]),
    ];

    return [...new Set(variants.flatMap((variant) => keysOf(variant, path)))];
  }

  if (spec.type === "keyed") {
    return [...new Set(Object.values(spec.variants).flatMap((variant) => keysOf(variant, path)))];
  }

  if (spec.type === "either") {
    return keysOf(spec.object, path);
  }

  return spec.type === "array" ? keysOf(spec.items, `${path}[]`) : [];
};

export const layerKeys = () => keysOf(LAYER_SPEC, "");
