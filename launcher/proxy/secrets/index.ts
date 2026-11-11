import type { SecretRef } from "../../config/index.ts";
import type { CommandRunner } from "../../shared/index.ts";
import { createSignIn } from "../sign-in.ts";
import { type CachedSecret, createSecretCache } from "./cache.ts";
import { commandSecret } from "./command.ts";
import { envSecret } from "./env.ts";
import { type SecretReply, SecretUnavailable } from "./errors.ts";
import { fileSecret } from "./file.ts";
import { createMcpOAuthSource } from "./mcp-oauth.ts";
import { piAuthSecret } from "./pi-auth.ts";

export { envSecretsFor, parentProxyAuth } from "./env.ts";
export type { SecretReply } from "./errors.ts";

export interface SecretResolverDeps {
  runner: CommandRunner;
  home: string;
  now: () => number;
  piCommand: string[];
  stateDir: string;
  hostAgentDir: string;
  envSecrets: ReadonlyMap<string, string>;
  childEnv?: Record<string, string>;
  logFile?: string;
  signInWaitMs?: number;
}

export type SecretResult =
  | { ok: true; value: string; expiresAt?: number }
  | { ok: false; reason: string; reply?: SecretReply; login?: boolean };

export interface SecretResolver {
  resolve(key: string, ref: SecretRef): Promise<SecretResult>;
  invalidate(key: string): void;
  rejected(key: string, ref: SecretRef, value: string | undefined): Promise<SecretReply | undefined>;
  close(): Promise<void>;
}

const kindOf = (ref: SecretRef) => Object.keys(ref)[0] ?? "unknown";

const success = (secret: CachedSecret): SecretResult =>
  secret.expiresAt === undefined
    ? { ok: true, value: secret.value }
    : { ok: true, value: secret.value, expiresAt: secret.expiresAt };

const failure = (key: string, ref: SecretRef, error: unknown): SecretResult => {
  if (!(error instanceof SecretUnavailable)) {
    return { ok: false, reason: `${kindOf(ref)} secret for ${key} failed` };
  }

  return {
    ok: false,
    reason: error.message,
    ...(error.reply === undefined ? {} : { reply: error.reply }),
    ...(error.login ? { login: true } : {}),
  };
};

export const createSecretResolver = (deps: SecretResolverDeps): SecretResolver => {
  const cache = createSecretCache(deps.now);
  const signIn = createSignIn({
    stateDir: deps.stateDir,
    hostAgentDir: deps.hostAgentDir,
    piCommand: deps.piCommand,
    env: deps.childEnv ?? {},
    now: deps.now,
    logFile: deps.logFile,
  });
  const mcpOAuth = createMcpOAuthSource({
    now: deps.now,
    hostAgentDir: deps.hostAgentDir,
    signIn,
    signInWaitMs: deps.signInWaitMs,
  });

  const load = (key: string, ref: SecretRef) => async () => {
    if ("command" in ref) {
      return commandSecret({
        key,
        kind: "command",
        argv: ref.command,
        runner: deps.runner,
        now: deps.now,
      });
    }

    if ("piAuth" in ref) {
      return piAuthSecret(key, ref, deps);
    }

    if ("mcpOAuth" in ref) {
      return mcpOAuth.resolve(key, ref);
    }

    if ("file" in ref) {
      return fileSecret(key, ref, deps.home);
    }

    return envSecret(key, deps.envSecrets);
  };

  const fetch = (key: string, ref: SecretRef) => {
    if ("env" in ref || "file" in ref) {
      return load(key, ref)();
    }

    return cache.get(key, load(key, ref));
  };

  const resolve = async (key: string, ref: SecretRef) =>
    fetch(key, ref).then(success, (error: unknown) => failure(key, ref, error));

  const rejected = async (key: string, ref: SecretRef, value: string | undefined) =>
    "mcpOAuth" in ref ? mcpOAuth.reject(key, ref, value).catch(() => undefined) : undefined;

  return { resolve, invalidate: cache.invalidate, rejected, close: signIn.close };
};
