import { isJsonObject } from "../shared/index.ts";

export const getPath = (target: unknown, key: string) =>
  key.split(".").reduce<unknown>((node, part) => (isJsonObject(node) ? node[part] : undefined), target);

export const setPath = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => {
  const [head, ...rest] = key.split(".");

  if (rest.length === 0) {
    return { ...target, [head]: value };
  }

  const child = target[head];

  return { ...target, [head]: setPath(isJsonObject(child) ? child : {}, rest.join("."), value) };
};
