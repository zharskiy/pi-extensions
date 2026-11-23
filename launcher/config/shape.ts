import { isJsonObject } from "../shared/index.ts";

export type Check = (value: string) => string | undefined;

export type ObjectCheck = (value: Record<string, unknown>) => string | undefined;

export type ListCheck = (value: unknown[]) => string | undefined;

export interface ObjectSpec {
  type: "object";
  properties: Record<string, Spec>;
  required?: readonly string[];
  check?: ObjectCheck;
  atomic?: true;
}

interface NumberSpec {
  type: "number";
  exclusiveMinimum?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
}

export type Spec =
  | { type: "string"; check?: Check; values?: readonly string[]; named?: true }
  | NumberSpec
  | { type: "true" }
  | { type: "boolean" }
  | { type: "array"; items: Spec; check?: ListCheck }
  | { type: "map"; key: Check; value: Spec }
  | ObjectSpec
  | { type: "keyed"; variants: Record<string, ObjectSpec> }
  | { type: "custom"; problem: (value: unknown, path: string) => Problem | undefined; keys?: Spec };

export interface Problem {
  path: string;
  problem: string;
}

export const shape = (properties: Record<string, Spec>, required?: readonly string[]): ObjectSpec => ({
  type: "object",
  properties,
  required,
});

export const keyPath = (prefix: string, key: string) => `${prefix}[${JSON.stringify(key)}]`;

export const joinPath = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

export const at = (path: string, problem: string | undefined): Problem | undefined =>
  problem === undefined ? undefined : { path, problem };

export const firstProblem = (problems: Array<() => Problem | undefined>) =>
  problems.reduce<Problem | undefined>((found, next) => found ?? next(), undefined);

const MAX_SHOWN = 200;

const PRINTABLE = /^[\x20-\x7e]*$/;

export const shown = (value: string) => {
  const cut = value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}...` : value;

  return PRINTABLE.test(cut) && cut.trim() !== "" ? cut : JSON.stringify(cut);
};

export const named = (value: unknown, problem: string | undefined) =>
  problem === undefined || typeof value !== "string" ? problem : `${shown(value)} ${problem}`;

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

export const objectProblem = (spec: ObjectSpec, value: unknown, path: string): Problem | undefined => {
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

const keyedProblem = (spec: Extract<Spec, { type: "keyed" }>, value: unknown, path: string) => {
  if (!isJsonObject(value)) {
    return { path, problem: "must be an object" };
  }

  const names = Object.keys(spec.variants);
  const chosen = names.find((name) => Object.hasOwn(value, name));

  return chosen === undefined
    ? { path, problem: `must set one of ${names.join(", ")}` }
    : objectProblem(spec.variants[chosen], value, path);
};

const mapProblem = (spec: Extract<Spec, { type: "map" }>, value: unknown, path: string) =>
  isJsonObject(value)
    ? firstProblem(
        Object.entries(value).flatMap(([key, child]) => [
          () => at(keyPath(path, key), spec.key(key)),
          () => problemOf(spec.value, child, keyPath(path, key)),
        ]),
      )
    : { path, problem: "must be an object" };

export const problemOf = (spec: Spec, value: unknown, path: string): Problem | undefined => {
  if (spec.type === "string") {
    const problem = stringProblem(spec, value);

    return at(path, spec.named === true ? named(value, problem) : problem);
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

  if (spec.type === "map") {
    return mapProblem(spec, value, path);
  }

  return spec.type === "keyed" ? keyedProblem(spec, value, path) : objectProblem(spec, value, path);
};
