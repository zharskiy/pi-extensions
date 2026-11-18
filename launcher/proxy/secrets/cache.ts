import { singleFlight } from "../single-flight.ts";
import { SecretUnavailable } from "./errors.ts";

export interface CachedSecret {
  value: string;
  expiresAt?: number;
}

type SecretLoader = () => Promise<CachedSecret>;

export interface SecretCache {
  get(key: string, load: SecretLoader): Promise<CachedSecret>;
  invalidate(key: string): void;
}

const FAILURE_TTL_MS = 5_000;

interface CachedFailure {
  error: unknown;
  until: number;
}

export const createSecretCache = (now: () => number): SecretCache => {
  const values = new Map<string, CachedSecret>();
  const failures = new Map<string, CachedFailure>();
  const forced = new Set<string>();
  const flight = singleFlight<string, CachedSecret>();

  const isFresh = (entry: CachedSecret) => entry.expiresAt === undefined || now() < entry.expiresAt;

  const start = (key: string, load: SecretLoader) => async () => {
    forced.delete(key);

    try {
      const entry = await load();

      values.set(key, entry);

      failures.delete(key);

      return entry;
    } catch (error) {
      if (!(error instanceof SecretUnavailable && error.hostSignIn)) {
        failures.set(key, { error, until: now() + FAILURE_TTL_MS });
      }

      throw error;
    }
  };

  const get = (key: string, load: SecretLoader) => {
    const cached = values.get(key);
    const failed = failures.get(key);

    if (!forced.has(key) && cached !== undefined && isFresh(cached)) {
      return Promise.resolve(cached);
    }

    if (!forced.has(key) && failed !== undefined && now() < failed.until) {
      return Promise.reject(failed.error);
    }

    return flight(key, start(key, load));
  };

  const invalidate = (key: string) => {
    values.delete(key);

    failures.delete(key);

    forced.add(key);
  };

  return { get, invalidate };
};
