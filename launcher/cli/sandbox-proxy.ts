import type { CredentialRule, ParentProxy } from "../config/index.ts";
import {
  collectEnvSecrets,
  type DenialRecord,
  type EnvSecretEntry,
  PARENT_PROXY_SECRET_KEY,
  type ProxyInstance,
  repoProxyToken,
  writeProxyDynamic,
} from "../proxy/index.ts";
import { errorMessage, LauncherError, sha256Hex } from "../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "./deps.ts";
import type { HostSide } from "./derive.ts";
import { bundledPiCommand } from "./host-pi.ts";
import type { LaunchContext } from "./launch.ts";

export interface SandboxProxy {
  instance: ProxyInstance;
  policyHash: string;
  repoToken: string;
}

const DEFAULT_TLS_PORT = 443;

const PROXY_URL_KEYS = ["HTTPS_PROXY", "https_proxy"];

const parsedUrl = (text: string | undefined) => {
  try {
    return text === undefined || text === "" ? undefined : new URL(text);
  } catch {
    return undefined;
  }
};

const envProxyCredentials = (env: NodeJS.ProcessEnv) => {
  const url = parsedUrl(env.HTTPS_PROXY ?? env.https_proxy);

  return url === undefined || url.username === ""
    ? undefined
    : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
};

const withoutUserinfo = (text: string | undefined) => {
  const url = parsedUrl(text);

  return url === undefined ? text : `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
};

const daemonEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  ...Object.fromEntries(
    PROXY_URL_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, withoutUserinfo(env[key])]),
  ),
});

const startProxy = async (deps: CliDeps, context: LaunchContext) => {
  try {
    return await deps.proxy.ensure({
      config: context.effective.config,
      stateDir: context.stateDir,
      env: daemonEnv(deps.env),
      home: deps.home,
      egressCap: context.effective.egressCap,
      piCommand: (await bundledPiCommand(deps)) ?? [],
    });
  } catch (error) {
    throw new LauncherError(
      `the egress proxy could not start, refusing to run without it: ${errorMessage(error)}`,
      error instanceof LauncherError && error.hint !== undefined ? error.hint : "run pi sandbox doctor",
    );
  }
};

const parentProxyEntries = (parent: ParentProxy): EnvSecretEntry[] =>
  typeof parent === "object" && parent.auth !== undefined
    ? [{ key: PARENT_PROXY_SECRET_KEY, ref: parent.auth }]
    : [];

const envSecretEntries = (rules: CredentialRule[], parent: ParentProxy): EnvSecretEntry[] => [
  ...rules.filter((rule) => "env" in rule.secret).map((rule) => ({ key: rule.id, ref: rule.secret })),
  ...parentProxyEntries(parent),
];

const parentEnvSecret = (parent: ParentProxy, env: NodeJS.ProcessEnv): Record<string, string> => {
  const credentials = parent === "env" ? envProxyCredentials(env) : undefined;

  return credentials === undefined ? {} : { [PARENT_PROXY_SECRET_KEY]: credentials };
};

const handEnvSecrets = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  instance: ProxyInstance,
) => {
  const parent = context.effective.config.egress.parentProxy;
  const entries = envSecretEntries(host.derived.rules, parent);
  const reply = await deps.proxy.control(instance, {
    type: "env-secrets",
    secrets: { ...collectEnvSecrets(entries, deps.env), ...parentEnvSecret(parent, deps.env) },
  });

  if (!reply.ok) {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: the proxy did not take the environment secrets: ${reply.error}`,
    );
  }
};

export const openSandboxProxy = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
): Promise<SandboxProxy | undefined> => {
  if (!host.proxyNeeded) {
    return undefined;
  }

  const instance = await startProxy(deps, context);
  const repoToken = await repoProxyToken(context.stateDir, instance.policyHash, host.repoHash);

  await writeProxyDynamic(context.stateDir, instance.policyHash, {
    version: 1,
    rules: host.derived.rules,
    derivedHosts: host.derived.hosts,
    tokens: { [sha256Hex(repoToken)]: host.repoHash },
  });

  await handEnvSecrets(deps, context, host, instance);

  return { instance, policyHash: instance.policyHash, repoToken };
};

export const authorityOf = (host: string, port: number) =>
  port === DEFAULT_TLS_PORT ? host : `${host}:${port}`;

const deniedAuthorities = (denials: DenialRecord[]) => [
  ...new Set(denials.map((denial) => authorityOf(denial.host, denial.port))),
];

export const reportDenials = async (
  deps: CliDeps,
  context: LaunchContext,
  proxy: SandboxProxy | undefined,
  since: number,
) => {
  if (proxy === undefined) {
    return;
  }

  const denials = await deps.proxy
    .denials(context.stateDir, proxy.policyHash, { repoHash: sha256Hex(context.workspace.repoRoot), since })
    .catch(() => []);

  writeLines(
    deps.stderr,
    deniedAuthorities(denials).map(
      (target) => `pi-sandbox: ${target} was blocked; run pi sandbox egress allow ${target}`,
    ),
  );
};
