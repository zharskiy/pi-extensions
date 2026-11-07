import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

export const envSecret = (key: string, envSecrets: ReadonlyMap<string, string>): CachedSecret => {
  const value = envSecrets.get(key);

  if (value === undefined || value === "") {
    throw unavailable(`env secret for ${key} was not handed to the proxy by the launcher`);
  }

  return { value };
};

export const collectEnvValues = (
  entries: Array<{ key: string; ref: object }>,
  env: Record<string, string | undefined>,
) =>
  entries.reduce<Record<string, string>>((secrets, entry) => {
    const name = "env" in entry.ref && typeof entry.ref.env === "string" ? entry.ref.env : undefined;
    const value = name === undefined ? undefined : env[name];

    if (value !== undefined && value !== "") {
      secrets[entry.key] = value;
    }

    return secrets;
  }, {});
