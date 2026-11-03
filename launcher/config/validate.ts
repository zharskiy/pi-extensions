import { isAbsolute } from "node:path";
import { BACKEND_NAMES, isSecretName, LauncherError } from "../shared/index.ts";
import { isRecord } from "./dotted.ts";
import type { LayerConfig } from "./types.ts";

type Check = (value: string) => string | undefined;

interface ObjectSpec {
  type: "object";
  properties: Record<string, Spec>;
  required?: readonly string[];
}

type Spec =
  | { type: "string"; check?: Check; values?: readonly string[] }
  | { type: "number"; exclusiveMinimum: number }
  | { type: "true" }
  | { type: "boolean" }
  | { type: "array"; items: Spec }
  | ObjectSpec
  | { type: "variants"; tag: string; variants: Record<string, ObjectSpec> };

interface Problem {
  path: string;
  problem: string;
}

const HOST = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$/;

const MAX_PORT = 65535;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HEADER = /^[A-Za-z0-9-]+$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

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

const text = (check?: Check): Spec => ({ type: "string", check });

const choice = (values: readonly string[]): Spec => ({ type: "string", values });

const list = (check?: Check): Spec => ({ type: "array", items: text(check) });

const positive: Spec = { type: "number", exclusiveMinimum: 0 };

const LAYER_SPEC: ObjectSpec = {
  type: "object",
  properties: {
    $schema: text(),
    profile: choice(["enterprise", "team", "solo"]),
    backend: choice(["auto", ...BACKEND_NAMES]),
    fallback: choice(["refuse", "host"]),
    image: { type: "object", properties: { reference: text(nonEmpty), digest: text(digest) } },
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
      variants: {
        static: {
          type: "object",
          required: ["kind"],
          properties: { kind: choice(["static"]), envVar: text(variable), keychainService: text(nonEmpty) },
        },
        "host-pi-auth": {
          type: "object",
          required: ["kind"],
          properties: { kind: choice(["host-pi-auth"]), authFile: text(absolutePath) },
        },
        sso: {
          type: "object",
          required: ["kind", "command"],
          properties: { kind: choice(["sso"]), command: list(nonEmpty) },
        },
      },
    },
    egress: {
      type: "object",
      properties: { allow: list(host), mcpHosts: list(host), denyPrivateAddresses: { type: "true" } },
    },
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
  },
};

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

const numberProblem = (spec: { exclusiveMinimum: number }, value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "must be a number";
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
  ]);
};

const variantProblem = (
  spec: { tag: string; variants: Record<string, ObjectSpec> },
  value: unknown,
  path: string,
): Problem | undefined => {
  if (!isRecord(value)) {
    return { path, problem: "must be an object" };
  }

  const names = Object.keys(spec.variants);
  const tag = value[spec.tag];

  if (typeof tag !== "string" || !names.includes(tag)) {
    return { path: joinPath(path, spec.tag), problem: `must be one of ${names.join(", ")}` };
  }

  return objectProblem(spec.variants[tag], value, path);
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
      ? firstProblem(value.map((item, index) => () => problemOf(spec.items, item, `${path}[${index}]`)))
      : { path, problem: "must be an array" };
  }

  return spec.type === "object" ? objectProblem(spec, value, path) : variantProblem(spec, value, path);
};

export const validateLayer = (value: unknown, layerName: string): LayerConfig => {
  const found = problemOf(LAYER_SPEC, value, "");

  if (found !== undefined) {
    throw new LauncherError(
      found.path === "" ? `${layerName}: ${found.problem}` : `${layerName}: ${found.path} ${found.problem}`,
    );
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
    return [...new Set(Object.values(spec.variants).flatMap((variant) => keysOf(variant, path)))];
  }

  return spec.type === "array" ? keysOf(spec.items, `${path}[]`) : [];
};

export const layerKeys = () => keysOf(LAYER_SPEC, "");
