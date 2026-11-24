export const globalRecord = <T>(name: string, init: () => T): T => {
  const store = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(`pinata.${name}`);

  store[key] ??= init();

  return store[key] as T;
};
