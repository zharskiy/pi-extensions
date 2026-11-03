export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getPath = (target: unknown, key: string) =>
  key.split(".").reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), target);

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

  return { ...target, [head]: setPath(isRecord(child) ? child : {}, rest.join("."), value) };
};
