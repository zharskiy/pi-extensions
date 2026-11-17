import { type CredentialRule, parentProxyOf, type SecretRef } from "../../config/index.ts";
import { LauncherError, urlPartOf } from "../../shared/index.ts";
import { HEADER_BREAK, HEADER_BREAK_PROBLEM } from "../rules.ts";
import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

interface EnvSecretEntry {
  key: string;
  ref: SecretRef;
}

const unusable = (subject: string) => `${subject} ${HEADER_BREAK_PROBLEM} and cannot be used as a credential`;

export const envSecret = (key: string, envSecrets: ReadonlyMap<string, string>): CachedSecret => {
  const value = envSecrets.get(key);

  if (value === undefined || value === "") {
    throw unavailable(`env secret for ${key} was not handed to the proxy by the launcher`);
  }

  if (HEADER_BREAK.test(value)) {
    throw unavailable(unusable(`env secret for ${key}`));
  }

  return { value };
};

const envNameOf = (entry: EnvSecretEntry) =>
  "env" in entry.ref && typeof entry.ref.env === "string" ? entry.ref.env : undefined;

const envSecretEntries = (rules: CredentialRule[]): EnvSecretEntry[] =>
  rules.filter((rule) => "env" in rule.secret).map((rule) => ({ key: rule.id, ref: rule.secret }));

export const parentProxyAuth = (env: NodeJS.ProcessEnv) => {
  const target = parentProxyOf(env);

  return target === undefined || "unsupported" in target ? undefined : target.credentials;
};

const envValueOf = (entry: EnvSecretEntry, env: NodeJS.ProcessEnv) => {
  const name = envNameOf(entry);
  const value = name === undefined ? undefined : env[name];

  return "env" in entry.ref ? urlPartOf(value, entry.ref) : value;
};

const isBroken = (entry: EnvSecretEntry, env: NodeJS.ProcessEnv) =>
  [env[envNameOf(entry) ?? ""], envValueOf(entry, env)].some((value) => HEADER_BREAK.test(value ?? ""));

const assertSingleLine = (entries: EnvSecretEntry[], env: NodeJS.ProcessEnv) => {
  const broken = entries.find((entry) => isBroken(entry, env));

  if (broken !== undefined) {
    throw new LauncherError(unusable(envNameOf(broken) ?? broken.key));
  }
};

const envValues = (entries: EnvSecretEntry[], env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    entries.flatMap((entry) => {
      const value = envValueOf(entry, env);

      return value === undefined || value === "" ? [] : [[entry.key, value] as const];
    }),
  );

export const envSecretsFor = (rules: CredentialRule[], env: NodeJS.ProcessEnv): Record<string, string> => {
  const entries = envSecretEntries(rules);

  assertSingleLine(entries, env);

  return envValues(entries, env);
};
