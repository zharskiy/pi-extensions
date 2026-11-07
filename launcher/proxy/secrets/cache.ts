export interface CachedSecret {
  value: string;
  expiresAt?: number;
}

export interface SecretLoadOptions {
  forced: boolean;
}

type SecretLoader = (options: SecretLoadOptions) => Promise<CachedSecret>;

export interface SecretCache {
  get(key: string, load: SecretLoader): Promise<CachedSecret>;
  invalidate(key: string): void;
}

export const createSecretCache = (now: () => number): SecretCache => {
  const values = new Map<string, CachedSecret>();
  const pending = new Map<string, Promise<CachedSecret>>();
  const forced = new Set<string>();

  const isFresh = (entry: CachedSecret | undefined) =>
    entry !== undefined && (entry.expiresAt === undefined || now() < entry.expiresAt);

  const start = (key: string, load: SecretLoader) => {
    const force = forced.delete(key);
    const loading = load({ forced: force })
      .then((entry) => {
        values.set(key, entry);

        return entry;
      })
      .finally(() => pending.delete(key));

    pending.set(key, loading);

    return loading;
  };

  const get = (key: string, load: SecretLoader) => {
    const inFlight = pending.get(key);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const cached = values.get(key);

    if (!forced.has(key) && cached !== undefined && isFresh(cached)) {
      return Promise.resolve(cached);
    }

    return start(key, load);
  };

  const invalidate = (key: string) => {
    values.delete(key);

    forced.add(key);
  };

  return { get, invalidate };
};
