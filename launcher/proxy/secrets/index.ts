import type { SecretRef } from "../../config/index.ts";
import { type CommandRunner, LauncherError } from "../../shared/index.ts";

export const PARENT_PROXY_SECRET_KEY = "egress.parentProxy";

export interface SecretResolverDeps {
  runner: CommandRunner;
  home: string;
  now: () => number;
  piCommand: string[];
  mcpAuthDir: string;
  envSecrets: () => ReadonlyMap<string, string>;
}

export type SecretResult = { ok: true; value: string; expiresAt?: number } | { ok: false; reason: string };

export interface SecretResolver {
  resolve(key: string, ref: SecretRef): Promise<SecretResult>;
  invalidate(key: string): void;
}

export interface EnvSecretEntry {
  key: string;
  ref: SecretRef;
}

export const createSecretResolver = (_deps: SecretResolverDeps): SecretResolver => {
  throw new LauncherError("createSecretResolver is not implemented");
};

export const collectEnvSecrets = (
  _entries: EnvSecretEntry[],
  _env: Record<string, string | undefined>,
): Record<string, string> => {
  throw new LauncherError("collectEnvSecrets is not implemented");
};
