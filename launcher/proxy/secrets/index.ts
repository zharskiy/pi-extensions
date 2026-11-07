import type { SecretRef } from "../../config/index.ts";
import type { CommandRunner } from "../../shared/index.ts";
import { type CachedSecret, createSecretCache, type SecretLoadOptions } from "./cache.ts";
import { commandSecret } from "./command.ts";
import { collectEnvValues, envSecret } from "./env.ts";
import { SecretUnavailable } from "./errors.ts";
import { fileSecret } from "./file.ts";
import { createMcpOAuthSource } from "./mcp-oauth.ts";
import { piAuthSecret } from "./pi-auth.ts";

export const PARENT_PROXY_SECRET_KEY = "egress.parentProxy";

export interface SecretResolverDeps {
  runner: CommandRunner;
  home: string;
  now: () => number;
  piCommand: string[];
  mcpAuthDir: string;
  envSecrets: (repoHash: string | undefined) => Promise<ReadonlyMap<string, string>>;
}

export type SecretResult = { ok: true; value: string; expiresAt?: number } | { ok: false; reason: string };

export interface SecretResolver {
  resolve(key: string, ref: SecretRef, repoHash?: string): Promise<SecretResult>;
  invalidate(key: string): void;
}

export interface EnvSecretEntry {
  key: string;
  ref: SecretRef;
}

const kindOf = (ref: SecretRef) => Object.keys(ref)[0] ?? "unknown";

const success = (secret: CachedSecret): SecretResult =>
  secret.expiresAt === undefined
    ? { ok: true, value: secret.value }
    : { ok: true, value: secret.value, expiresAt: secret.expiresAt };

const failure = (key: string, ref: SecretRef, error: unknown): SecretResult => ({
  ok: false,
  reason: error instanceof SecretUnavailable ? error.message : `${kindOf(ref)} secret for ${key} failed`,
});

export const createSecretResolver = (deps: SecretResolverDeps): SecretResolver => {
  const cache = createSecretCache(deps.now);
  const mcpOAuth = createMcpOAuthSource(deps);
  const entries = new Map<string, Set<string>>();

  const cacheKey = (key: string, ref: SecretRef) => {
    const composite = `${key}\n${JSON.stringify(ref)}`;

    entries.set(key, new Set([...(entries.get(key) ?? []), composite]));

    return composite;
  };

  const invalidate = (key: string) => {
    (entries.get(key) ?? new Set<string>()).forEach((composite) => {
      cache.invalidate(composite);
    });
  };

  const load = (key: string, ref: SecretRef, repoHash?: string) => async (options: SecretLoadOptions) => {
    if ("command" in ref) {
      return commandSecret({
        key,
        kind: "command",
        argv: ref.command,
        ttlSeconds: ref.ttlSeconds,
        runner: deps.runner,
        now: deps.now,
      });
    }

    if ("piAuth" in ref) {
      return piAuthSecret(key, ref, deps);
    }

    if ("mcpOAuth" in ref) {
      return mcpOAuth(key, ref, options);
    }

    if ("file" in ref) {
      return fileSecret(key, ref, deps.home);
    }

    return envSecret(key, await deps.envSecrets(repoHash));
  };

  const fetch = (key: string, ref: SecretRef, repoHash?: string) => {
    if ("env" in ref || "file" in ref) {
      return load(key, ref, repoHash)({ forced: true });
    }

    return cache.get(cacheKey(key, ref), load(key, ref));
  };

  const resolve = async (key: string, ref: SecretRef, repoHash?: string) =>
    fetch(key, ref, repoHash).then(success, (error: unknown) => failure(key, ref, error));

  return { resolve, invalidate };
};

export const collectEnvSecrets = (
  entries: EnvSecretEntry[],
  env: Record<string, string | undefined>,
): Record<string, string> => collectEnvValues(entries, env);
