import { isJsonObject, type JsonObject } from "../shared/index.ts";

export const getPath = (target: unknown, key: string) =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) => (isJsonObject(node) && Object.hasOwn(node, part) ? node[part] : undefined),
      target,
    );

export const setPath = (target: JsonObject, key: string, value: unknown): JsonObject => {
  const [head, ...rest] = key.split(".");

  if (rest.length === 0) {
    return { ...target, [head]: value };
  }

  const child = target[head];

  return { ...target, [head]: setPath(isJsonObject(child) ? child : {}, rest.join("."), value) };
};

export const withoutPath = (target: JsonObject, key: string): JsonObject => {
  const [head, ...rest] = key.split(".");

  if (!Object.hasOwn(target, head)) {
    return target;
  }

  const kept = Object.fromEntries(Object.entries(target).filter(([name]) => name !== head));

  if (rest.length === 0) {
    return kept;
  }

  const child = target[head];

  if (!isJsonObject(child)) {
    return target;
  }

  const trimmed = withoutPath(child, rest.join("."));

  if (trimmed === child) {
    return target;
  }

  return Object.keys(trimmed).length === 0 ? kept : { ...target, [head]: trimmed };
};
