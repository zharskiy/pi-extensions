import type { CredentialRule, ParentProxy, SecretRef } from "../../config/index.ts";
import { LauncherError, urlPartOf } from "../../shared/index.ts";
import type { CachedSecret } from "./cache.ts";
import { unavailable } from "./errors.ts";

export const PARENT_PROXY_SECRET_KEY = "egress.parentProxy";

interface EnvSecretEntry {
  key: string;
  ref: SecretRef;
}

const LINE_BREAK = /[\r\n]/;

export const envSecret = (key: string, envSecrets: ReadonlyMap<string, string>): CachedSecret => {
  const value = envSecrets.get(key);

  if (value === undefined || value === "") {
    throw unavailable(`env secret for ${key} was not handed to the proxy by the launcher`);
  }

  if (LINE_BREAK.test(value)) {
    throw unavailable(`env secret for ${key} holds a line break; remove it from the variable`);
  }

  return { value };
};

const envNameOf = (entry: EnvSecretEntry) =>
  "env" in entry.ref && typeof entry.ref.env === "string" ? entry.ref.env : undefined;

const envSecretEntries = (rules: CredentialRule[]): EnvSecretEntry[] =>
  rules.filter((rule) => "env" in rule.secret).map((rule) => ({ key: rule.id, ref: rule.secret }));

const envProxyCredentials = (env: NodeJS.ProcessEnv) => {
  const text = env.HTTPS_PROXY ?? env.https_proxy;

  try {
    const url = text === undefined || text === "" ? undefined : new URL(text);

    return url === undefined || url.username === ""
      ? undefined
      : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  } catch {
    return undefined;
  }
};

export const parentProxyAuth = (parent: ParentProxy, env: NodeJS.ProcessEnv) =>
  parent === "env" ? envProxyCredentials(env) : undefined;

const assertSingleLine = (entries: EnvSecretEntry[], env: NodeJS.ProcessEnv) => {
  const broken = entries
    .map(envNameOf)
    .find((name) => name !== undefined && LINE_BREAK.test(env[name] ?? ""));

  if (broken !== undefined) {
    throw new LauncherError(`${broken} contains a line break and cannot be used as a credential`);
  }
};

const envValueOf = (entry: EnvSecretEntry, env: NodeJS.ProcessEnv) => {
  const name = envNameOf(entry);
  const value = name === undefined ? undefined : env[name];

  return "env" in entry.ref ? urlPartOf(value, entry.ref) : value;
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
