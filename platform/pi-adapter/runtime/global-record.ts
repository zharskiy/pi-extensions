export const globalRecord = <T>(name: string, init: () => T): T => {
  const store = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(`pi-extensions.${name}`);

  store[key] ??= init();

  return store[key] as T;
};
