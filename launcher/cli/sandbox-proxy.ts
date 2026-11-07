import type { Backend } from "../backend/index.ts";
import { type CredentialRule, grantCapBlocker, type ParentProxy } from "../config/index.ts";
import { mcpDiscoverCommand } from "../hostpi/index.ts";
import {
  collectEnvSecrets,
  type DenialRecord,
  type EnvSecretEntry,
  PARENT_PROXY_SECRET_KEY,
  type ProxyInstance,
  repoProxyToken,
  writeProxyDynamic,
} from "../proxy/index.ts";
import { errorMessage, LauncherError, sha256Hex, stateLayout, withFileLock } from "../shared/index.ts";
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

const DAEMON_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_SANDBOX_STATE_DIR",
  "PI_SANDBOX_USER_CONFIG",
  "PI_SANDBOX_POLICY_FILE",
  "PI_SANDBOX_TEST_RESOLVE",
];

const LINE_BREAK = /[\r\n]/;

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

const pickEnv = (env: NodeJS.ProcessEnv, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));

export const daemonEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...pickEnv(env, DAEMON_ENV_KEYS),
  ...Object.fromEntries(
    PROXY_URL_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, withoutUserinfo(env[key])]),
  ),
});

const discoverCommandOf = async (deps: CliDeps) => {
  const pi = await deps.bundledPi();

  return pi === undefined ? {} : { discoverCommand: mcpDiscoverCommand(pi) };
};

const startProxy = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  try {
    return await deps.proxy.ensure({
      listenHosts: await backend.proxyListenHosts(),
      config: context.effective.config,
      stateDir: context.stateDir,
      env: daemonEnv(deps.env),
      home: deps.home,
      egressCap: context.effective.egressCap,
      piCommand: (await bundledPiCommand(deps)) ?? [],
      ...(await discoverCommandOf(deps)),
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

const envNameOf = (entry: EnvSecretEntry) =>
  "env" in entry.ref && typeof entry.ref.env === "string" ? entry.ref.env : undefined;

const assertSingleLine = (entries: EnvSecretEntry[], env: NodeJS.ProcessEnv) => {
  const broken = entries
    .map(envNameOf)
    .find((name) => name !== undefined && LINE_BREAK.test(env[name] ?? ""));

  if (broken !== undefined) {
    throw new LauncherError(`${broken} contains a line break and cannot be used as a credential`);
  }
};

const handEnvSecrets = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  proxy: { instance: ProxyInstance; repoToken: string },
) => {
  const parent = context.effective.config.egress.parentProxy;
  const entries = envSecretEntries(host.derived.rules, parent);

  assertSingleLine(entries, deps.env);

  const reply = await deps.proxy.control(proxy.instance, {
    type: "env-secrets",
    repoTokenHash: sha256Hex(proxy.repoToken),
    secrets: { ...collectEnvSecrets(entries, deps.env), ...parentEnvSecret(parent, deps.env) },
  });

  if (!reply.ok) {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: the proxy did not take the environment secrets: ${reply.error}`,
    );
  }
};

type ProxyDynamic = Parameters<typeof writeProxyDynamic>[2];

export const recordProxyDynamic = (stateDir: string, policyHash: string, dynamic: ProxyDynamic) =>
  withFileLock(`${stateLayout(stateDir).proxyDynamic(policyHash)}.lock`, () =>
    writeProxyDynamic(stateDir, policyHash, dynamic),
  );

export const openSandboxProxy = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  backend: Backend,
): Promise<SandboxProxy | undefined> => {
  if (!host.proxyNeeded) {
    return undefined;
  }

  const instance = await startProxy(deps, context, backend);
  const repoToken = await repoProxyToken(context.stateDir, instance.policyHash, host.repoHash);

  await recordProxyDynamic(context.stateDir, instance.policyHash, {
    version: 1,
    rules: host.derived.rules,
    derivedHosts: host.derived.hosts,
    vault: host.derived.vault,
    tokens: { [sha256Hex(repoToken)]: host.repoHash },
  });

  await handEnvSecrets(deps, context, host, { instance, repoToken });

  return { instance, policyHash: instance.policyHash, repoToken };
};

export const authorityOf = (host: string, port: number) =>
  port === DEFAULT_TLS_PORT ? host : `${host}:${port}`;

const deniedTargets = (denials: DenialRecord[]) => [
  ...new Map(denials.map((denial) => [authorityOf(denial.host, denial.port), denial])).values(),
];

const denialLine = (context: LaunchContext, denial: DenialRecord) => {
  const target = authorityOf(denial.host, denial.port);
  const blocker = grantCapBlocker(context.effective, denial.host, denial.port);

  return blocker === undefined
    ? `pi-sandbox: ${target} was blocked; run pi sandbox egress allow ${target}`
    : `pi-sandbox: ${target} is outside the allowlist set by policy or org`;
};

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
    deniedTargets(denials).map((denial) => denialLine(context, denial)),
  );
};
