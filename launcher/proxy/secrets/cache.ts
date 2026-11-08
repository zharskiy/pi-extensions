import { singleFlight } from "../single-flight.ts";

export interface CachedSecret {
  value: string;
  expiresAt?: number;
}

type SecretLoader = () => Promise<CachedSecret>;

export interface SecretCache {
  get(key: string, load: SecretLoader): Promise<CachedSecret>;
  invalidate(key: string): void;
}

export const createSecretCache = (now: () => number): SecretCache => {
  const values = new Map<string, CachedSecret>();
  const forced = new Set<string>();
  const flight = singleFlight<string, CachedSecret>();

  const isFresh = (entry: CachedSecret) => entry.expiresAt === undefined || now() < entry.expiresAt;

  const start = (key: string, load: SecretLoader) => async () => {
    forced.delete(key);

    const entry = await load();

    values.set(key, entry);

    return entry;
  };

  const get = (key: string, load: SecretLoader) => {
    const cached = values.get(key);

    if (!forced.has(key) && cached !== undefined && isFresh(cached)) {
      return Promise.resolve(cached);
    }

    return flight(key, start(key, load));
  };

  const invalidate = (key: string) => {
    values.delete(key);

    forced.add(key);
  };

  return { get, invalidate };
};
